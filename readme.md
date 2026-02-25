# koishi-plugin-morfonicapixivbot

[![npm](https://img.shields.io/npm/v/koishi-plugin-morfonicapixivbot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-morfonicapixivbot)
[![npm](https://img.shields.io/npm/l/koishi-plugin-morfonicapixivbot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-morfonicapixivbot)

**最新版本**: 0.2.3

Koishi 插件，用于在聊天机器人中集成 Pixiv 图片搜索和排行榜功能。

## 功能特性

- **关键词搜索** - 支持使用关键词搜索 Pixiv 插画，可配置排序方式和搜索范围
- **多种排行榜** - 支持每日、每周、每月、原创、新人、男性/女性向、AI 生成等多种排行榜
- **推荐插画** - 获取 Pixiv 个性化推荐作品
- **插画详情** - 根据 ID 查询特定插画作品
- **分页浏览** - 支持「下一页」命令查看更多结果
- **R18 过滤** - 可配置是否包含 R18 内容
- **多页图片支持** - 自动处理多页插画
- **连接测试** - 内置诊断命令验证配置

## 安装

```bash
npm install koishi-plugin-morfonicapixivbot
```

或在 Koishi 控制台添加插件

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `refreshToken` | `string` | 必填 | Pixiv OAuth Refresh Token，用于身份认证 |
| `searchResultCount` | `number` | `3` | 每次搜索/排行榜返回的图片数量 (1-10) |
| `enableR18` | `boolean` | `false` | 是否包含 R18 内容 |

## 命令列表

### 搜索命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `搜图 [关键词]` | `pixiv` | 使用关键词搜索 Pixiv 图片 |
| `搜图 [关键词] --sort <类型>` | - | 指定排序方式：`popular`(人气) / `date`(最新) |
| `搜图 [关键词] --target <类型>` | - | 指定搜索范围：`tag`(标签) / `exact`(精确) / `title`(标题) / `keyword`(关键词) |
| `搜图 [关键词] --duration <类型>` | - | 指定时间范围：`day`(日) / `week`(周) / `month`(月) |

### 排行榜命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `每日热门` | `daily-ranking` | 获取 Pixiv 每日排行榜 |
| `每周热门` | `weekly-ranking` | 获取 Pixiv 每周排行榜 |
| `每月热门` | `monthly-ranking` | 获取 Pixiv 每月排行榜 |
| `原创热门` | `original-ranking` | 获取 Pixiv 原创每周榜 |
| `新人热门` | `rookie-ranking` | 获取 Pixiv 新人每周榜 |
| `男性热门` | `male-ranking` | 获取 Pixiv 男性向每日榜 |
| `女性热门` | `female-ranking` | 获取 Pixiv 女性向每日榜 |
| `AI 热门` | `ai-ranking` | 获取 Pixiv AI 生成每日榜 |
| `R18 每日` | `daily-r18` | 获取 Pixiv R18 每日排行榜（需启用 R18） |
| `R18 每周` | `weekly-r18` | 获取 Pixiv R18 每周排行榜（需启用 R18） |

### 其他命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `推荐插画` | `推荐` / `pixiv 推荐` | 获取 Pixiv 个性化推荐插画 |
| `插画详情 <ID>` | `详情` / `pixiv 详情` | 根据 ID 查询插画详情 |
| `下一页` | `next-page` | 查看当前搜索/排行榜的下一页结果 |
| `pixiv-test` | `测图` | 测试 Pixiv 连接和 Token 配置是否正常 |

## 使用示例

```
# 搜索命令
用户：搜图 初音ミク
机器人：[发送 3 张图片]
       这里是 3 张图片，跟我说"下一页"查看更多~

用户：搜图 初音ミク --sort date
机器人：[发送按最新上传排序的 3 张图片]

用户：搜图 初音ミク --target title
机器人：[发送标题中包含关键词的 3 张图片]

用户：搜图 初音ミク --sort popular --duration week
机器人：[发送周内人气最高的 3 张图片]

# 排行榜命令
用户：每日热门
机器人：[发送当日排行榜前 3 的作品]
       这里是 3 张热门图片，跟我说"下一页"查看更多~

用户：每周热门
机器人：[发送每周排行榜前 3 的作品]

用户：原创热门
机器人：[发送原创周榜前 3 的作品]

用户：AI 热门
机器人：[发送 AI 生成每日榜前 3 的作品]

# 推荐和详情命令
用户：推荐插画
机器人：[发送个性化推荐的 3 张图片]

用户：插画详情 12345678
机器人：[发送 ID 为 12345678 的插画]

# 分页命令
用户：下一页
机器人：[发送下一页的 3 张图片]
       已发送 3 张图片，输入"下一页"查看更多

# 测试命令
用户：测图
机器人：✅ Pixiv 连接测试成功！
       - 代理配置：http://127.0.0.1:7897
       - Token 状态：有效
       - 用户 ID: 12345678
```

## 技术实现

### 依赖库

- [@book000/pixivts](https://www.npmjs.com/package/@book000/pixivts) - Pixiv API TypeScript 客户端
- `axios` - HTTP 请求库，用于下载图片
- `https-proxy-agent` - HTTPS 代理支持

### 核心机制

1. **身份认证** - 使用 Refresh Token 获取访问令牌
2. **图片下载** - 通过代理直接下载图片并作为消息发送
3. **状态管理** - 使用 `Map<string, SearchState>` 存储每个用户的搜索状态
4. **内容过滤** - 根据 `xRestrict` 字段和标签过滤 R18 内容
5. **错误处理** - 详细的日志输出和友好的错误提示

### 网络架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Koishi    │────▶│  代理服务器   │────▶│   Pixiv     │
│   插件       │     │ (可选)        │     │   API/CDN   │
└─────────────┘     └──────────────┘     └─────────────┘
```

## 注意事项

1. **Refresh Token 获取** - 需要从 Pixiv 网页版登录后获取
2. **代理配置** - 中国大陆地区需要配置 HTTP 代理才能访问 Pixiv
3. **并发限制** - Pixiv API 有速率限制，请合理使用

## License

MIT
