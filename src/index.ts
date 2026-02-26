import { Context, Schema, h } from 'koishi'
import { Pixiv } from '@book000/pixivts'
import { SearchSort, RankingMode, SearchTarget } from '@book000/pixivts/dist/options'
import axios from 'axios'

export const name = 'morfonicapixivbot'

export interface Config {
  /** Pixiv OAuth Refresh Token */
  refreshToken: string
  /** 每次搜索返回的图片数量 */
  searchResultCount: number
  /** 是否包含 R18 内容 */
  enableR18: boolean
  /** 是否包含 AI 生成内容 */
  enableAI: boolean
}

export const Config: Schema<Config> = Schema.object({
  refreshToken: Schema.string()
    .required()
    .role('secret')
    .description('Pixiv OAuth Refresh Token，用于鉴权'),
  searchResultCount: Schema.number()
    .default(3)
    .min(1)
    .max(10)
    .description('每次搜索返回的图片数量'),
  enableR18: Schema.boolean()
    .default(false)
    .description('是否包含 R18 内容'),
  enableAI: Schema.boolean()
    .default(false)
    .description('是否包含 AI 生成内容'),
})

interface SearchState {
  type: 'search' | 'ranking' | 'recommended' | 'author' | 'favorites'
  keyword?: string
  rankingMode?: RankingMode
  searchTarget?: SearchTarget
  searchSort?: SearchSort
  authorId?: number
  authorIllusts?: any[]
  favoriteIds?: number[]
  lastIllustId?: number
  offset: number
  nextUrl: string | null
}

export function apply(ctx: Context, config: Config) {
  // 存储用户搜索状态的 Map
  const searchStates = new Map<string, SearchState>()

  // 定义收藏表
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctx.model as any).extend('pixiv_favorites', {
    id: { type: 'integer', autoIncrement: true, primary: true },
    userId: { type: 'string' },
    platform: { type: 'string' },
    illustId: { type: 'integer', index: true },
    createdAt: { type: 'integer' },
  })

  // 获取 sessionId
  const getSessionId = (session: any) => {
    return `${session.platform}:${session.userId}`
  }

  // 枚举映射工具函数
  const sortMap: Record<string, SearchSort> = {
    'popular': SearchSort.POPULAR_DESC,
    'date': SearchSort.DATE_DESC,
  }

  const targetMap: Record<string, SearchTarget> = {
    'tag': SearchTarget.PARTIAL_MATCH_FOR_TAGS,
    'exact': SearchTarget.EXACT_MATCH_FOR_TAGS,
    'title': SearchTarget.TITLE_AND_CAPTION,
    'keyword': SearchTarget.KEYWORD,
  }

  // 日志助手函数
  const log = (level: 'info' | 'warn' | 'error', message: string, ...args: any[]) => {
    const prefix = '[PixivBot]'
    if (level === 'error') {
      ctx.logger.error(`${prefix} ${message}`, ...args)
    } else if (level === 'warn') {
      ctx.logger.warn(`${prefix} ${message}`, ...args)
    } else {
      ctx.logger.info(`${prefix} ${message}`, ...args)
    }
  }

  const logProxyEnv = (tag: string) => {
    log('info', `${tag} 代理环境变量`, {
      HTTPS_PROXY: process.env.HTTPS_PROXY || '未设置',
      HTTP_PROXY: process.env.HTTP_PROXY || '未设置',
      https_proxy: process.env.https_proxy || '未设置',
      http_proxy: process.env.http_proxy || '未设置',
      ALL_PROXY: process.env.ALL_PROXY || '未设置',
      all_proxy: process.env.all_proxy || '未设置',
      NO_PROXY: process.env.NO_PROXY || '未设置',
      no_proxy: process.env.no_proxy || '未设置',
    })
  }

  const summarizeHeaders = (headers?: any) => {
    if (!headers) return undefined
    return {
      server: headers.server,
      'cf-ray': headers['cf-ray'],
      'cf-cache-status': headers['cf-cache-status'],
      'cf-mitigated': headers['cf-mitigated'],
      'content-type': headers['content-type'],
      location: headers.location,
      'set-cookie': headers['set-cookie'],
    }
  }

  const toShortBody = (data: any) => {
    if (data == null) return undefined
    if (typeof data === 'string') return data.slice(0, 400)
    try {
      return JSON.stringify(data).slice(0, 400)
    } catch {
      return undefined
    }
  }

  // 初始化 Pixiv 客户端
  const initPixiv = async () => {
    log('info', '正在初始化 Pixiv 客户端...')
    log('info', `Node 版本：${process.version}`)
    logProxyEnv('初始化前')
    try {
      const client = await Pixiv.of(config.refreshToken)
      log('info', 'Pixiv 客户端初始化成功', { userId: client.userId })
      return client
    } catch (error: any) {
      log('error', 'Pixiv 认证失败', {
        message: error.message,
        stack: error.stack,
        response: toShortBody(error.response?.data),
        status: error.response?.status,
        headers: summarizeHeaders(error.response?.headers),
        code: error.code,
        address: error.address,
        syscall: error.syscall,
        hostname: error.hostname,
        port: error.port,
      })
      throw new Error(`Pixiv 认证失败：${error.message}`)
    }
  }

  // 下载图片并发送
  const sendIllust = async (session: any, illust: any, page: number = 0) => {
    try {
      // Pixiv API 返回的是 image_urls 而不是 urls
      // 如果是多页图片，从 meta_pages 获取；否则从 image_urls 获取
      let imageUrl: string | undefined
      let imageUrlsLog: any = illust.image_urls

      // 检查是否为多页图片
      if (illust.meta_pages && illust.meta_pages.length > 0) {
        if (page >= 0 && page < illust.meta_pages.length) {
          imageUrl = illust.meta_pages[page].image_urls?.large ??
                     illust.meta_pages[page].image_urls?.medium ??
                     illust.meta_pages[page].image_urls?.square_medium
          imageUrlsLog = illust.meta_pages[page].image_urls
        }
      } else {
        // 单页图片
        imageUrl = illust.image_urls?.large ??
                   illust.image_urls?.medium ??
                   illust.image_urls?.square_medium
      }

      log('info', '准备下载图片', {
        illustId: illust.id,
        title: illust.title,
        page,
        imageUrls: imageUrlsLog,
        selectedUrl: imageUrl,
      })

      if (!imageUrl) {
        log('warn', '图片 URL 不存在', {
          illustId: illust.id,
          title: illust.title,
          imageUrls: imageUrlsLog,
        })
        return
      }

      // 使用代理下载图片
      const axiosConfig: any = {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://www.pixiv.net/',
        },
      }

      const response = await axios.get(imageUrl, axiosConfig)
      const imageBuffer = Buffer.from(response.data, 'binary')

      log('info', '图片下载成功', {
        illustId: illust.id,
        size: imageBuffer.length,
      })

      const pageCount = illust.meta_pages?.length || 1
      const pageText = pageCount > 1 ? ` [${page + 1}/${pageCount}]` : ''

      const message = [
        h.image(imageBuffer, 'image/png'),
        h.text(`\n标题：${illust.title}${pageText}`),
        h.text(`\n作者：${illust.user?.name || '未知'}`),
        h.text(`\nID: ${illust.id}`),
      ]

      await session.send(message)
      log('info', '图片发送成功', { illustId: illust.id, page })

      // 更新最近一次展示的插画 ID
      const sessionId = `${session.platform}:${session.userId}`
      const state = searchStates.get(sessionId)
      if (state) {
        searchStates.set(sessionId, {
          ...state,
          lastIllustId: illust.id,
        })
      }
    } catch (error: any) {
      log('error', '发送图片失败', {
        illustId: illust.id,
        page,
        message: error.message,
        stack: error.stack,
        code: error.code,
      })
      throw error
    }
  }

  // 过滤 R18 和 AI 内容
  const filterIllusts = (illusts: any[]) => {
    if (config.enableR18) {
      log('info', 'R18 模式已启用，不过滤 R18 内容')
    }
    if (config.enableAI) {
      log('info', 'AI 模式已启用，不过滤 AI 内容')
    }

    const filtered = illusts.filter(illust => {
      // 检查 xRestrict 标记 (R18)
      if (!config.enableR18 && illust.xRestrict) {
        log('info', '过滤 R18 图片 (xRestrict)', { illustId: illust.id, title: illust.title })
        return false
      }
      // 检查 R18 标签
      if (!config.enableR18 && illust.tags) {
        const hasR18Tag = illust.tags.some((tag: any) => {
          const tagName = (tag as any).name?.toLowerCase() || ''
          return tagName.includes('r-18') || tagName.includes('r18')
        })
        if (hasR18Tag) {
          log('info', '过滤 R18 图片 (标签)', { illustId: illust.id, title: illust.title })
          return false
        }
      }
      // 检查 AI 生成标签
      if (!config.enableAI && illust.tags) {
        const hasAITag = illust.tags.some((tag: any) => {
          const tagName = (tag as any).name?.toLowerCase() || ''
          return tagName.includes('ai') || tagName.includes('ai生成') || tagName.includes('生成ai')
        })
        if (hasAITag) {
          log('info', '过滤 AI 生成图片', { illustId: illust.id, title: illust.title })
          return false
        }
      }
      return true
    })
    log('info', `内容过滤完成：${illusts.length} -> ${filtered.length}`)
    return filtered
  }

  // 搜图命令
  log('info', '注册搜图命令，带选项：sort, target, duration')
  ctx.command('搜图 [keywords:text]', '使用关键词搜索 Pixiv 图片')
    .alias('pixiv')
    .option('sort', '-s <type>')
    .option('target', '-t <type>')
    .option('duration', '-d <type>')
    .action(async ({ session, options }, keywords) => {
      if (!keywords) {
        return '请输入要搜索的关键词哦~，比如，搜图 初音ミク'
      }

      const sessionId = getSessionId(session)
      log('info', `收到搜图请求`, { sessionId, keywords, options })

      try {
        const pixiv = await initPixiv()

        // 解析搜索选项
        const searchSort = sortMap[options.sort || 'popular']
        const searchTarget = targetMap[options.target || 'tag']

        // 构建搜索参数
        const searchParams: any = {
          word: keywords,
          offset: 0,
          searchTarget,
          sort: searchSort,
        }

        // 时间范围参数（仅人气排序有效）
        if (options.duration) {
          searchParams.searchAim = options.duration
        }

        log('info', '执行搜索', {
          keyword: keywords,
          offset: 0,
          searchTarget,
          sort: searchSort,
          duration: options.duration,
        })

        const result = await pixiv.searchIllust(searchParams)

        log('info', '搜索响应原始数据', {
          status: result.status,
          illustsCount: result.data.illusts?.length || 0,
          nextUrl: result.data.next_url,
        })

        const illusts = filterIllusts(result.data.illusts || [])

        if (illusts.length === 0) {
          log('warn', '未找到相关图片', { keywords })
          return '没有找到相关的图片哦......请尝试更换关键词或者检查拼写~'
        }

        // 保存搜索状态
        searchStates.set(sessionId, {
          type: 'search',
          keyword: keywords,
          searchTarget,
          searchSort,
          offset: illusts.length,
          nextUrl: result.data.next_url || null,
        })
        log('info', '搜索状态已保存', { sessionId, state: searchStates.get(sessionId) })

        // 发送图片
        const toSend = illusts.slice(0, config.searchResultCount)
        log('info', `准备发送 ${toSend.length} 张图片`)
        for (const illust of toSend) {
          await sendIllust(session, illust)
        }

        if (illusts.length >= config.searchResultCount) {
          return `这里是 ${toSend.length} 张图片，跟我说"下一页"查看更多~`
        }
      } catch (error: any) {
        log('error', '搜图过程发生错误', {
          keywords,
          sessionId,
          message: error.message,
          stack: error.stack,
          response: error.response?.data,
          status: error.response?.status,
          code: error.code,
          address: error.address,
          syscall: error.syscall,
        })
        return `搜索失败......${error.message || '请求失败，请重试'}`
      }
    })

  // 每日热门排行榜命令（保留向后兼容）
  log('info', '注册每日热门命令')
  ctx.command('每日热门', '获取 Pixiv 每日排行榜')
    .alias('daily-ranking')
    .action(async ({ session }) => {
      const sessionId = getSessionId(session)
      log('info', `收到每日热门请求`, { sessionId })

      try {
        const pixiv = await initPixiv()

        log('info', '获取每日排行榜', { mode: RankingMode.DAY })

        const result = await pixiv.illustRanking({
          mode: RankingMode.DAY,
        })

        log('info', '排行榜响应原始数据', {
          status: result.status,
          illustsCount: result.data.illusts?.length || 0,
          nextUrl: result.data.next_url,
        })

        const illusts = filterIllusts(result.data.illusts || [])

        if (illusts.length === 0) {
          log('warn', '排行榜无数据')
          return '暂无排行榜数据哦......'
        }

        // 保存搜索状态
        searchStates.set(sessionId, {
          type: 'ranking',
          rankingMode: RankingMode.DAY,
          offset: illusts.length,
          nextUrl: result.data.next_url || null,
        })
        log('info', '排行榜状态已保存', { sessionId })

        // 发送图片
        const toSend = illusts.slice(0, config.searchResultCount)
        log('info', `准备发送 ${toSend.length} 张热门图片`)
        for (const illust of toSend) {
          await sendIllust(session, illust)
        }

        return `这里是 ${toSend.length} 张热门图片，跟我说"下一页"查看更多~`
      } catch (error: any) {
        log('error', '获取排行榜失败', {
          sessionId,
          message: error.message,
          stack: error.stack,
          response: error.response?.data,
          status: error.response?.status,
          code: error.code,
          address: error.address,
          syscall: error.syscall,
        })
        return `获取排行榜失败：${error.message || '请求失败，请重试'}`
      }
    })

  // 排行榜命令配置
  const rankingCommands = [
    { cmd: '每周热门', alias: 'weekly-ranking', mode: RankingMode.WEEK, desc: '获取 Pixiv 每周排行榜' },
    { cmd: '每月热门', alias: 'monthly-ranking', mode: RankingMode.MONTH, desc: '获取 Pixiv 每月排行榜' },
    { cmd: '原创热门', alias: 'original-ranking', mode: RankingMode.WEEK_ORIGINAL, desc: '获取 Pixiv 原创每周榜' },
    { cmd: '新人热门', alias: 'rookie-ranking', mode: RankingMode.WEEK_ROOKIE, desc: '获取 Pixiv 新人每周榜' },
    { cmd: '男性热门', alias: 'male-ranking', mode: RankingMode.DAY_MALE, desc: '获取 Pixiv 男性向每日榜' },
    { cmd: '女性热门', alias: 'female-ranking', mode: RankingMode.DAY_FEMALE, desc: '获取 Pixiv 女性向每日榜' },
    { cmd: 'AI 热门', alias: 'ai-ranking', mode: RankingMode.DAY_AI, desc: '获取 Pixiv AI 生成每日榜' },
  ]

  // 批量注册排行榜命令
  for (const { cmd, alias, mode, desc } of rankingCommands) {
    log('info', `注册排行榜命令：${cmd} (alias: ${alias})`)
    ctx.command(cmd, desc)
      .alias(alias)
      .action(async ({ session }) => {
        const sessionId = getSessionId(session)
        log('info', `收到 ${cmd} 请求`, { sessionId, mode })

        try {
          const pixiv = await initPixiv()

          log('info', '获取排行榜', { mode })

          const result = await pixiv.illustRanking({
            mode,
          })

          log('info', '排行榜响应原始数据', {
            status: result.status,
            illustsCount: result.data.illusts?.length || 0,
            nextUrl: result.data.next_url,
          })

          const illusts = filterIllusts(result.data.illusts || [])

          if (illusts.length === 0) {
            log('warn', '排行榜无数据', { mode })
            return '暂无排行榜数据哦......'
          }

          // 保存搜索状态
          searchStates.set(sessionId, {
            type: 'ranking',
            rankingMode: mode,
            offset: illusts.length,
            nextUrl: result.data.next_url || null,
          })
          log('info', '排行榜状态已保存', { sessionId })

          // 发送图片
          const toSend = illusts.slice(0, config.searchResultCount)
          log('info', `准备发送 ${toSend.length} 张热门图片`)
          for (const illust of toSend) {
            await sendIllust(session, illust)
          }

          return `这里是 ${toSend.length} 张热门图片，跟我说"下一页"查看更多~`
        } catch (error: any) {
          log('error', '获取排行榜失败', {
            sessionId,
            mode,
            message: error.message,
            stack: error.stack,
            response: error.response?.data,
            status: error.response?.status,
            code: error.code,
            address: error.address,
            syscall: error.syscall,
          })
          return `获取排行榜失败：${error.message || '请求失败，请重试'}`
        }
      })
  }

  // R18 排行榜命令（需要 enableR18 配置）
  const r18RankingCommands = [
    { cmd: 'R18 每日', alias: 'daily-r18', mode: RankingMode.DAY_R18, desc: '获取 Pixiv R18 每日排行榜（需启用 R18）' },
    { cmd: 'R18 每周', alias: 'weekly-r18', mode: RankingMode.WEEK_R18, desc: '获取 Pixiv R18 每周排行榜（需启用 R18）' },
  ]

  for (const { cmd, alias, mode, desc } of r18RankingCommands) {
    log('info', `注册 R18 排行榜命令：${cmd} (alias: ${alias})`)
    ctx.command(cmd, desc)
      .alias(alias)
      .action(async ({ session }) => {
        if (!config.enableR18) {
          return 'R18 内容已被禁用，如需使用请联系管理员配置 enableR18 选项'
        }

        const sessionId = getSessionId(session)
        log('info', `收到 ${cmd} 请求`, { sessionId, mode })

        try {
          const pixiv = await initPixiv()

          log('info', '获取 R18 排行榜', { mode })

          const result = await pixiv.illustRanking({
            mode,
          })

          log('info', 'R18 排行榜响应原始数据', {
            status: result.status,
            illustsCount: result.data.illusts?.length || 0,
            nextUrl: result.data.next_url,
          })

          const illusts = result.data.illusts || []

          if (illusts.length === 0) {
            log('warn', 'R18 排行榜无数据', { mode })
            return '暂无排行榜数据哦......'
          }

          // 保存搜索状态
          searchStates.set(sessionId, {
            type: 'ranking',
            rankingMode: mode,
            offset: illusts.length,
            nextUrl: result.data.next_url || null,
          })
          log('info', 'R18 排行榜状态已保存', { sessionId })

          // 发送图片
          const toSend = illusts.slice(0, config.searchResultCount)
          log('info', `准备发送 ${toSend.length} 张 R18 图片`)
          for (const illust of toSend) {
            await sendIllust(session, illust)
          }

          return `这里是 ${toSend.length} 张热门图片，跟我说"下一页"查看更多~`
        } catch (error: any) {
          log('error', '获取 R18 排行榜失败', {
            sessionId,
            mode,
            message: error.message,
            stack: error.stack,
            response: error.response?.data,
            status: error.response?.status,
            code: error.code,
            address: error.address,
            syscall: error.syscall,
          })
          return `获取排行榜失败：${error.message || '请求失败，请重试'}`
        }
      })
  }

  // 推荐插画命令
  log('info', '注册推荐插画命令')
  ctx.command('推荐插画', '获取 Pixiv 个性化推荐插画')
    .alias('pixiv 推荐')
    .alias('推荐')
    .action(async ({ session }) => {
      const sessionId = getSessionId(session)
      log('info', `收到推荐插画请求`, { sessionId })

      try {
        const pixiv = await initPixiv()

        log('info', '获取推荐插画')

        const result = await pixiv.illustRecommended()

        log('info', '推荐插画响应原始数据', {
          status: result.status,
          illustsCount: result.data.illusts?.length || 0,
          nextUrl: result.data.next_url,
        })

        const illusts = filterIllusts(result.data.illusts || [])

        if (illusts.length === 0) {
          log('warn', '推荐插画无数据')
          return '暂无推荐插画数据哦......'
        }

        // 保存搜索状态
        searchStates.set(sessionId, {
          type: 'recommended',
          offset: illusts.length,
          nextUrl: result.data.next_url || null,
        })
        log('info', '推荐插画状态已保存', { sessionId })

        // 发送图片
        const toSend = illusts.slice(0, config.searchResultCount)
        log('info', `准备发送 ${toSend.length} 张推荐图片`)
        for (const illust of toSend) {
          await sendIllust(session, illust)
        }

        return `这里是 ${toSend.length} 张推荐图片，跟我说"下一页"查看更多~`
      } catch (error: any) {
        log('error', '获取推荐插画失败', {
          sessionId,
          message: error.message,
          stack: error.stack,
          response: error.response?.data,
          status: error.response?.status,
          code: error.code,
          address: error.address,
          syscall: error.syscall,
        })
        return `获取推荐失败：${error.message || '请求失败，请重试'}`
      }
    })

  // 插画详情查询命令
  log('info', '注册插画详情命令')
  ctx.command('插画详情 <illustId:number>', '根据 ID 查询插画详情')
    .alias('pixiv 详情')
    .alias('详情')
    .action(async ({ session }, illustId: number) => {
      if (!illustId) {
        return '请输入要查询的插画 ID 哦~，比如：插画详情 12345678'
      }

      const sessionId = getSessionId(session)
      log('info', `收到插画详情请求`, { sessionId, illustId })

      try {
        const pixiv = await initPixiv()

        log('info', '获取插画详情', { illustId })

        const result = await pixiv.illustDetail({ illustId })

        log('info', '插画详情响应原始数据', {
          status: result.status,
          illustId: result.data.illust?.id,
        })

        const illust = result.data.illust

        if (!illust) {
          log('warn', '未找到插画', { illustId })
          return '没有找到该 ID 的插画哦......请检查 ID 是否正确'
        }

        // 发送插画
        await sendIllust(session, illust)

        return null
      } catch (error: any) {
        log('error', '获取插画详情失败', {
          illustId,
          sessionId,
          message: error.message,
          stack: error.stack,
          response: error.response?.data,
          status: error.response?.status,
          code: error.code,
        })
        return `获取插画详情失败：${error.message || '请求失败，请重试'}`
      }
    })

  // 按作者 ID 搜索作品命令
  log('info', '注册搜作者命令')
  ctx.command('搜作者 <authorId:number>', '根据作者 ID 搜索该作者的作品')
    .alias('作者作品')
    .action(async ({ session }, authorId: number) => {
      if (!authorId) {
        return '请输入要查询的作者 ID 哦~，比如：搜作者 12345678'
      }

      const sessionId = getSessionId(session)
      log('info', `收到搜作者请求`, { sessionId, authorId })

      try {
        const pixiv = await initPixiv()

        log('info', '获取作者作品', { authorId })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (pixiv as any).userIllusts({
          userId: authorId,
          offset: 0,
        })

        log('info', '作者作品响应原始数据', {
          status: result.status,
          illustsCount: result.data.illusts?.length || 0,
          nextUrl: result.data.next_url,
        })

        const illusts = filterIllusts(result.data.illusts || [])

        if (illusts.length === 0) {
          log('warn', '作者无作品', { authorId })
          return '该作者还没有作品哦......'
        }

        // 保存搜索状态
        searchStates.set(sessionId, {
          type: 'author',
          authorId,
          authorIllusts: illusts,
          offset: illusts.length,
          nextUrl: result.data.next_url || null,
        })
        log('info', '搜作者状态已保存', { sessionId })

        // 发送图片
        const toSend = illusts.slice(0, config.searchResultCount)
        log('info', `准备发送 ${toSend.length} 张作者图片`)
        for (const illust of toSend) {
          await sendIllust(session, illust)
        }

        return `这里是 ${toSend.length} 张图片，跟我说"下一页"查看更多~`
      } catch (error: any) {
        log('error', '获取作者作品失败', {
          authorId,
          sessionId,
          message: error.message,
          stack: error.stack,
          response: error.response?.data,
          status: error.response?.status,
          code: error.code,
        })
        return `获取作者作品失败：${error.message || '请求失败，请重试'}`
      }
    })

  // 收藏命令
  log('info', '注册收藏命令')
  ctx.command('收藏', '收藏最近一次展示的插画')
    .alias('fav')
    .action(async ({ session }) => {
      const sessionId = getSessionId(session)
      const state = searchStates.get(sessionId)

      if (!state || !state.lastIllustId) {
        return '没有可收藏的图片哦~请先使用"搜图"或"每日热门"等命令展示图片'
      }

      const illustId = state.lastIllustId

      try {
        // 检查是否已经收藏过
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await ctx.database.get('pixiv_favorites' as any, {
          userId: session.userId,
          platform: session.platform,
          illustId,
        })

        if (existing.length > 0) {
          return '这张图片已经收藏过了哦~'
        }

        // 添加收藏
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ctx.database.create('pixiv_favorites' as any, {
          userId: session.userId,
          platform: session.platform,
          illustId,
          createdAt: Date.now(),
        })

        log('info', '收藏成功', { sessionId, illustId })
        return `收藏成功！插画 ID: ${illustId}`
      } catch (error: any) {
        log('error', '收藏失败', {
          sessionId,
          illustId,
          message: error.message,
          stack: error.stack,
        })
        return `收藏失败：${error.message || '请重试'}`
      }
    })

  // 查询最爱命令
  log('info', '注册查询最爱命令')
  ctx.command('查询最爱', '查看已收藏的插画列表')
    .alias('favorites')
    .action(async ({ session }) => {
      const sessionId = getSessionId(session)
      log('info', `收到查询最爱请求`, { sessionId })

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const favorites = await ctx.database.get('pixiv_favorites' as any, {
          userId: session.userId,
          platform: session.platform,
        })

        if (favorites.length === 0) {
          return '你还没有收藏任何插画哦~使用"收藏"命令来收藏图片吧！'
        }

        // 按收藏时间倒序排列
        const sortedFavorites = favorites.sort((a: any, b: any) => b.createdAt - a.createdAt)
        const favoriteIds = sortedFavorites.map((f: any) => f.illustId)

        // 保存搜索状态
        searchStates.set(sessionId, {
          type: 'favorites',
          favoriteIds,
          offset: 0,
          nextUrl: null,
        })

        // 获取插画详情
        const pixiv = await initPixiv()
        const toSend: any[] = []
        const count = Math.min(config.searchResultCount, favoriteIds.length)

        for (let i = 0; i < count; i++) {
          try {
            const result = await pixiv.illustDetail({ illustId: favoriteIds[i] })
            if (result.data.illust) {
              toSend.push(result.data.illust)
            }
          } catch (e: any) {
            log('warn', '获取插画详情失败', { illustId: favoriteIds[i], message: e.message })
          }
        }

        if (toSend.length === 0) {
          return '无法获取收藏的插画详情'
        }

        // 发送图片
        for (const illust of toSend) {
          await sendIllust(session, illust)
        }

        const total = favoriteIds.length
        if (total > config.searchResultCount) {
          return `共收藏了 ${total} 张插画，跟我说"下一页"查看更多~`
        }
        return `显示 ${toSend.length} 张收藏插画`
      } catch (error: any) {
        log('error', '查询最爱失败', {
          sessionId,
          message: error.message,
          stack: error.stack,
        })
        return `查询失败：${error.message || '请重试'}`
      }
    })

  // 下一页命令
  log('info', '注册下一页命令')
  ctx.command('下一页', '查看下一页搜索结果')
    .alias('next-page')
    .action(async ({ session }) => {
      const sessionId = getSessionId(session)
      const state = searchStates.get(sessionId)

      log('info', `收到下一页请求`, { sessionId, hasState: !!state, state })

      if (!state) {
        return '你还没有输入"搜图"或"每日热门"命令开始搜索呢...没有下一页哦~'
      }

      try {
        const pixiv = await initPixiv()
        let result: any

        if (state.type === 'search' && state.keyword) {
          log('info', '继续搜索', {
            keyword: state.keyword,
            offset: state.offset,
            searchTarget: state.searchTarget,
            searchSort: state.searchSort,
          })
          const searchParams: any = {
            word: state.keyword,
            offset: state.offset,
            searchTarget: state.searchTarget,
            sort: state.searchSort,
          }
          result = await pixiv.searchIllust(searchParams)
        } else if (state.type === 'ranking') {
          log('info', '继续获取排行榜', {
            mode: state.rankingMode,
            offset: state.offset,
          })
          result = await pixiv.illustRanking({
            mode: state.rankingMode,
            offset: state.offset,
          })
        } else if (state.type === 'recommended') {
          log('info', '继续获取推荐插画', {
            offset: state.offset,
          })
          result = await pixiv.illustRecommended({
            offset: state.offset,
          })
        } else if (state.type === 'author') {
          // 作者作品：使用已获取的作品列表进行分页
          log('info', '继续获取作者作品', {
            authorId: state.authorId,
            offset: state.offset,
            totalIllusts: state.authorIllusts?.length || 0,
          })
          const allIllusts = state.authorIllusts || []
          const nextIllusts = allIllusts.slice(state.offset, state.offset + config.searchResultCount)

          if (nextIllusts.length === 0) {
            searchStates.delete(sessionId)
            log('info', '作者没有更多作品了，清除搜索状态', { sessionId })
            return '看起来没有更多图片了呢......'
          }

          // 发送图片
          for (const illust of nextIllusts) {
            await sendIllust(session, illust)
          }

          // 更新偏移量
          searchStates.set(sessionId, {
            ...state,
            offset: state.offset + nextIllusts.length,
          })

          return `已发送 ${nextIllusts.length} 张图片，输入"下一页"查看更多`
        } else if (state.type === 'favorites') {
          // 收藏列表：使用已获取的收藏 ID 列表进行分页
          log('info', '继续获取收藏插画', {
            offset: state.offset,
            totalFavorites: state.favoriteIds?.length || 0,
          })

          const favoriteIds = state.favoriteIds || []
          const startIdx = state.offset
          const endIdx = Math.min(startIdx + config.searchResultCount, favoriteIds.length)

          if (startIdx >= favoriteIds.length) {
            searchStates.delete(sessionId)
            log('info', '没有更多收藏了，清除搜索状态', { sessionId })
            return '看起来没有更多图片了呢......'
          }

          const idsToFetch = favoriteIds.slice(startIdx, endIdx)
          const toSend: any[] = []

          // 获取插画详情
          for (const illustId of idsToFetch) {
            try {
              const detailResult = await pixiv.illustDetail({ illustId })
              if (detailResult.data.illust) {
                toSend.push(detailResult.data.illust)
              }
            } catch (e: any) {
              log('warn', '获取插画详情失败', { illustId, message: e.message })
            }
          }

          if (toSend.length === 0) {
            return '无法获取收藏的插画详情'
          }

          // 发送图片
          for (const illust of toSend) {
            await sendIllust(session, illust)
          }

          // 更新偏移量
          searchStates.set(sessionId, {
            ...state,
            offset: state.offset + toSend.length,
          })

          return `已发送 ${toSend.length} 张图片，输入"下一页"查看更多`
        } else {
          log('warn', '未知的搜索状态', { state })
          return '搜索状态异常，请重新开始搜索'
        }

        log('info', '响应原始数据', {
          status: result.status,
          illustsCount: result.data.illusts?.length || 0,
          nextUrl: result.data.next_url,
        })

        const illusts = filterIllusts(result.data.illusts || [])

        if (illusts.length === 0) {
          searchStates.delete(sessionId)
          log('info', '没有更多图片了，清除搜索状态', { sessionId })
          return '看起来没有更多图片了呢......'
        }

        // 更新搜索状态
        searchStates.set(sessionId, {
          ...state,
          offset: state.offset + illusts.length,
          nextUrl: result.data.next_url || null,
        })
        log('info', '搜索状态已更新', { sessionId, state: searchStates.get(sessionId) })

        // 发送图片
        const toSend = illusts.slice(0, config.searchResultCount)
        log('info', `准备发送 ${toSend.length} 张图片`)
        for (const illust of toSend) {
          await sendIllust(session, illust)
        }

        return `已发送 ${toSend.length} 张图片，输入"下一页"查看更多`
      } catch (error: any) {
        log('error', '下一页请求失败', {
          sessionId,
          state,
          message: error.message,
          stack: error.stack,
          response: error.response?.data,
          status: error.response?.status,
          code: error.code,
          address: error.address,
          syscall: error.syscall,
        })
        return `获取失败：${error.message || '请求失败，请重试'}`
      }
    })

  // 插件加载完成日志
  log('info', '插件已加载，注册命令列表：', {
    config: {
      refreshToken: config.refreshToken ? '***' + config.refreshToken.slice(-4) : 'empty',
      searchResultCount: config.searchResultCount,
      enableR18: config.enableR18,
      enableAI: config.enableAI,
    },
    commands: [
      '搜图 [keywords] [--sort <type>] [--target <type>] [--duration <type>]',
      '搜作者 <authorId>',
      '每日热门',
      '每周热门',
      '每月热门',
      '原创热门',
      '新人热门',
      '男性热门',
      '女性热门',
      'AI 热门',
      'R18 每日 (需启用 R18)',
      'R18 每周 (需启用 R18)',
      '推荐插画',
      '插画详情 <illustId>',
      '收藏 / fav',
      '查询最爱 / favorites',
      '下一页',
      'pixiv-test',
    ],
  })

  // 测试命令 - 验证 Token 和代理配置
  ctx.command('pixiv-test', '测试 Pixiv Token 和代理配置是否正常')
    .alias('测图')
    .action(async ({ session }) => {
      log('info', `开始测试 Pixiv 连接... 用户：${session.userId}`)
      const result: any = {
        proxy: process.env.HTTPS_PROXY || '未设置',
        refreshToken: config.refreshToken ? '已配置' : '未配置',
        success: false,
        error: null,
      }

      try {
        // 先做一次网络可达性探测，避免 Token 请求阻塞排查
        const probeConfig: any = {
          timeout: 8000,
          maxRedirects: 0,
          validateStatus: () => true,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        }
        const probe = await axios.get('https://oauth.secure.pixiv.net', probeConfig)
        log('info', 'OAuth 可达性探测', {
          status: probe.status,
          headers: summarizeHeaders(probe.headers),
          body: probe.status >= 400 ? toShortBody(probe.data) : undefined,
        })

        const client = await Pixiv.of(config.refreshToken)
        result.userId = client.userId
        result.success = true
        log('info', '测试成功', { userId: client.userId })

        return `✅ Pixiv 连接测试成功！
- 代理配置：${result.proxy}
- Token 状态：有效
- 用户 ID: ${client.userId}`
      } catch (error: any) {
        result.error = error.message
        log('error', '测试失败', {
          error: error.message,
          code: error.code,
          syscall: error.syscall,
          address: error.address,
          port: error.port,
          response: toShortBody(error.response?.data),
          status: error.response?.status,
          headers: summarizeHeaders(error.response?.headers),
        })

        let errorMsg = `❌ Pixiv 连接测试失败！\n`
        errorMsg += `- 代理配置：${result.proxy}\n`
        errorMsg += `- 错误信息：${error.message}\n`

        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
          errorMsg += `\n💡 提示：这通常是网络连接问题。请检查：\n`
          errorMsg += `1. 代理地址是否正确配置\n`
          errorMsg += `2. 代理服务器是否正常运行\n`
          errorMsg += `3. 服务器是否可以访问代理服务器`
        } else if (error.message.includes('Failed to refresh token')) {
          errorMsg += `\n💡 提示：Token 刷新失败，可能原因：\n`
          errorMsg += `1. Refresh Token 已过期或无效，请重新获取\n`
          errorMsg += `2. 无法访问 Pixiv OAuth 服务器 (https://oauth.secure.pixiv.net)\n`
          errorMsg += `3. 代理配置不正确`
        }

        return errorMsg
      }
    })
}
