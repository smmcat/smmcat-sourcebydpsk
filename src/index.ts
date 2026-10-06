import { Context, h, Schema } from 'koishi'
import { } from 'koishi-plugin-canvas'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import stream from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Chat } from './chatSend'
export const name = 'smmcat-sourcebydpsk'

export interface Config {
  baseUrl: string,
  token: string
  model: string
  useMd: boolean
  deBug: boolean
  downloadPath: string,
  saucenaoKey: string
  traceKey: string
  similarityThreshold: number
}

/** 图片出处识别结果的 JSON 结构 */
export interface ImgSourceResult {
  name: string
  alias?: string
  author: string
  tag?: string
  detail?: string
  url?: string
}

/** 搜图引擎返回的单条结果 */
interface SearchHit {
  /** 搜索引擎名称 */
  engine: string
  /** 相似度 0~1 */
  similarity: number
  /** 作品/内容标题 */
  title?: string
  /** 作者/来源名称 */
  author?: string
  /** 外部链接列表 */
  urls: string[]
  /** 附加描述 */
  extra?: string
}

export const inject = ['canvas']
export const Config: Schema<Config> = Schema.object({
  useMd: Schema.boolean().default(true).description('使用 qqmd 格式发送'),
  deBug: Schema.boolean().default(false).description('日志查看更多消息'),
  baseUrl: Schema.string().default('https://api.deepseek.com').description('Deepseek接口基地址'),
  model: Schema.string().default('deepseek-flash').description('使用模型'),
  token: Schema.string().required().description('令牌'),
  downloadPath: Schema.string().default("./data/imgDpk/").description("图片保存位置"),
  saucenaoKey: Schema.string().default('').description('SauceNAO API Key（可选，注册 saucenao.com 后在账号页获取，提高搜索限额）'),
  traceKey: Schema.string().default('').description('trace.moe API Key（可选，Patreon 赞助后获取，提高动漫搜索限额）'),
  similarityThreshold: Schema.number().default(0.6).description('搜图结果相似度阈值（0~1），低于此值的结果将被忽略'),
})

export function apply(ctx: Context, config: Config) {

  ctx.on('ready', () => {
    Chat.init(config, ctx)
  })

  /** 节流：记录正在请求中的用户 ID，请求结束前不可再次发起 */
  const pendingUsers = new Set<string>()

  // ────────────────────────────────────────────────────────────
  //  以图搜图模块（SauceNAO + trace.moe 双引擎）
  // ────────────────────────────────────────────────────────────

  const reverseSearch = {
    /** 浏览器伪装请求头，绕过 Cloudflare 反爬 */
    browserHeaders: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },

    /**
     * 调用 SauceNAO 搜图 API。
     * 注意：SauceNAO 已禁止匿名 API 访问，必须填写有效的 saucenaoKey。
     * 注册地址：https://saucenao.com ，API Key 在账号页获取。
     */
    async saucenao(imgUrl: string): Promise<SearchHit[]> {
      if (!config.saucenaoKey) {
        config.deBug && console.log('[SauceNAO] 未配置 saucenaoKey，跳过（SauceNAO 已禁止匿名 API 访问）')
        return []
      }

      const params: Record<string, string> = {
        db: '999',
        output_type: '2',
        numres: '5',
        url: imgUrl,
        api_key: config.saucenaoKey,
      }

      try {
        const query = new URLSearchParams(params)
        const res = await ctx.http.get('https://saucenao.com/search.php?' + query.toString(), {
          headers: reverseSearch.browserHeaders,
          timeout: 15000,
        })

        const hits: SearchHit[] = []
        const results = res?.results || []
        const threshold = config.similarityThreshold

        for (const r of results) {
          const similarity = parseFloat(r?.header?.similarity) / 100
          if (isNaN(similarity) || similarity < threshold) continue

          const data = r?.data || {}
          const urls: string[] = []
          if (Array.isArray(data.ext_urls)) urls.push(...data.ext_urls)
          if (data.source) urls.push(String(data.source))

          hits.push({
            engine: 'SauceNAO',
            similarity,
            title: data.title ? String(data.title) : undefined,
            author: data.author ? String(data.author) : (data.creator ? String(data.creator) : undefined),
            urls,
            extra: data.jp_name ? String(data.jp_name) : undefined,
          })
        }

        config.deBug && console.log('[SauceNAO] 命中', hits.length, '条:', JSON.stringify(hits, null, 2))
        return hits
      } catch (e: any) {
        const status = e?.response?.status || e?.status || 'unknown'
        const body = e?.response?.data || e?.body || ''
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
        // 提取 SauceNAO 返回的具体错误信息
        const msgMatch = bodyStr.match(/"message":"([^"]+)"/)
        const detailMsg = msgMatch ? msgMatch[1] : ''
        console.log(`[SauceNAO] 请求失败: ${detailMsg || e?.message} | status=${status}`)
        if (status === 403) {
          console.log('[SauceNAO] 403 提示：请检查 saucenaoKey 是否正确。获取地址：https://saucenao.com → 登录 → 账号页 → API Key')
        }
        return []
      }
    },

    /**
     * 调用 IQDB 多引擎搜图（免费，无需 Key）。
     * 解析 HTML 返回结果。搜索 Danbooru / Konachan / yande.re / Gelbooru 等。
     * 官网：https://iqdb.org
     */
    async iqdb(imgUrl: string): Promise<SearchHit[]> {
      try {
        const res = await ctx.http.get<string>('https://iqdb.org/', {
          params: { url: imgUrl },
          headers: {
            ...reverseSearch.browserHeaders,
            'Referer': 'https://iqdb.org/',
          },
          timeout: 15000,
          responseType: 'text',
        })

        const html = (typeof res === 'string' ? res : String(res ?? '')) || ''
        if (!html) return []

        const hits: SearchHit[] = []
        const threshold = config.similarityThreshold

        // IQDB HTML 结构：每个匹配结果在 <tr> 中，包含 <td class="image"> 和相似度
        // 匹配所有 <tr>...</tr> 块
        const trRegex = /<tr>([\s\S]*?)<\/tr>/g
        let trMatch: RegExpExecArray | null

        while ((trMatch = trRegex.exec(html)) !== null) {
          const tr = trMatch[1]

          // 提取相似度（格式：XX.X% similarity）
          const simMatch = tr.match(/(\d+(?:\.\d+)?)\s*%\s*(?:similarity)?/i)
          if (!simMatch) continue
          const similarity = parseFloat(simMatch[1]) / 100
          if (similarity < threshold) continue

          // 提取链接（来源页面 URL）
          const hrefMatch = tr.match(/<a[^>]+href="([^"]+)"/i)
          const sourceUrl = hrefMatch ? hrefMatch[1] : ''

          // 提取图片缩略图 alt 或 title 作为标题线索
          const altMatch = tr.match(/(?:alt|title)="([^"]+)"/i)
          const title = altMatch ? altMatch[1] : undefined

          // 提取来源站点名称（从链接域名判断）
          let engine = 'IQDB'
          if (sourceUrl.includes('danbooru')) engine = 'IQDB:Danbooru'
          else if (sourceUrl.includes('konachan')) engine = 'IQDB:Konachan'
          else if (sourceUrl.includes('yande.re')) engine = 'IQDB:yande.re'
          else if (sourceUrl.includes('gelbooru')) engine = 'IQDB:Gelbooru'
          else if (sourceUrl.includes('sankaku')) engine = 'IQDB:Sankaku'
          else if (sourceUrl.includes('zerochan')) engine = 'IQDB:Zerochan'
          else if (sourceUrl.includes('anime-pictures')) engine = 'IQDB:AnimePictures'
          else if (sourceUrl.includes('e-shuushuu')) engine = 'IQDB:e-shuushuu'

          const urls: string[] = []
          if (sourceUrl) {
            // IQDB 返回的是相对路径或绝对路径，补全
            const fullUrl = sourceUrl.startsWith('http')
              ? sourceUrl
              : sourceUrl.startsWith('//')
                ? 'https:' + sourceUrl
                : 'https://iqdb.org' + sourceUrl
            urls.push(fullUrl)
          }

          hits.push({
            engine,
            similarity,
            title,
            urls,
          })
        }

        config.deBug && console.log('[IQDB] 命中', hits.length, '条:', JSON.stringify(hits, null, 2))
        return hits
      } catch (e: any) {
        const status = e?.response?.status || e?.status || 'unknown'
        console.log(`[IQDB] 请求失败: ${e?.message || e} | status=${status}`)
        return []
      }
    },

    /**
     * 调用 trace.moe 搜图 API（专门搜索动漫画面）。
     * 免费无 Key，约 100 次/24h/IP。
     * Docs: https://soruly.github.io/trace.moe-api/
     */
    async trace(imgUrl: string): Promise<SearchHit[]> {
      try {
        const headers: Record<string, string> = { ...reverseSearch.browserHeaders }
        if (config.traceKey) headers['x-trace-key'] = config.traceKey

        const res = await ctx.http.get('https://api.trace.moe/search', {
          params: { url: imgUrl },
          headers,
          timeout: 15000,
        })

        const hits: SearchHit[] = []
        const results = res?.result || []
        const threshold = config.similarityThreshold

        for (const r of results) {
          const similarity = r?.similarity
          if (typeof similarity !== 'number' || similarity < threshold) continue

          const urls: string[] = []
          if (r.video) urls.push(r.video)
          if (r.image) urls.push(r.image)

          // anilist ID 可用于查更多信息，这里先拼一个 AniList 链接
          if (r.anilist) urls.push(`https://anilist.co/anime/${r.anilist}`)

          const episode = r.episode ? `第 ${r.episode} 话` : ''
          const at = r.at ? `${Math.floor(r.at / 60)}:${String(Math.floor(r.at % 60)).padStart(2, '0')}` : ''
          const extra = [episode, at].filter(Boolean).join(' · ') || undefined

          hits.push({
            engine: 'trace.moe',
            similarity,
            title: r.filename ? String(r.filename).replace(/\.[^.]+$/, '') : undefined,
            urls,
            extra,
          })
        }

        config.deBug && console.log('[trace.moe] 命中', hits.length, '条:', JSON.stringify(hits, null, 2))
        return hits
      } catch (e: any) {
        const status = e?.response?.status || e?.status || 'unknown'
        const body = e?.response?.data || e?.body || ''
        const bodyPreview = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)
        console.log(`[trace.moe] 请求失败: ${e?.message || e} | status=${status} | body=${bodyPreview}`)
        return []
      }
    },

    /**
     * 并行调用所有搜图引擎，合并并按相似度排序。
     * 引擎优先级：IQDB（免费无需Key） > trace.moe（免费） > SauceNAO（需Key）
     */
    async searchAll(imgUrls: string[]): Promise<SearchHit[]> {
      const all: SearchHit[] = []

      // 对每张图并行搜索（IQDB + trace.moe 始终调用，SauceNAO 仅在配置了 Key 时调用）
      const tasks = imgUrls.flatMap(url => {
        const t: Promise<SearchHit[]>[] = [
          reverseSearch.iqdb(url),
          reverseSearch.trace(url),
        ]
        if (config.saucenaoKey) t.push(reverseSearch.saucenao(url))
        return t
      })

      const results = await Promise.allSettled(tasks)
      for (const r of results) {
        if (r.status === 'fulfilled') all.push(...r.value)
      }

      // 按相似度降序
      all.sort((a, b) => b.similarity - a.similarity)
      return all
    },
  }

  /**
   * 从 LLM 返回的原始文本中提取并解析 JSON。
   * 兼容：markdown 代码块包裹、前后多余文本、截断等情况。
   */
  function extractJson(raw: string): ImgSourceResult | null {
    if (!raw) return null

    // 1. 去除 markdown 代码块 ```json ... ``` 或 ``` ... ```
    let text = raw.trim()
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (codeBlockMatch) {
      text = codeBlockMatch[1].trim()
    }

    // 2. 尝试直接解析
    try {
      return JSON.parse(text) as ImgSourceResult
    } catch { /* fallthrough */ }

    // 3. 提取第一个 { 到最后一个 } 之间的内容
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonStr = text.slice(firstBrace, lastBrace + 1)
      try {
        return JSON.parse(jsonStr) as ImgSourceResult
      } catch { /* fallthrough */ }

      // 4. 尝试修复常见问题：未转义的换行、控制字符等
      try {
        const fixed = jsonStr
          .replace(/[\x00-\x1F\x7F]/g, '')          // 去除控制字符
          .replace(/,\s*([}\]])/g, '$1')            // 去除尾随逗号
          .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3') // 给未加引号的 key 加引号
        return JSON.parse(fixed) as ImgSourceResult
      } catch { /* fallthrough */ }
    }

    // 5. 尝试用括号计数法提取（处理嵌套）
    const start = text.indexOf('{')
    if (start !== -1) {
      let depth = 0
      let inStr = false
      let escape = false
      for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (escape) { escape = false; continue }
        if (ch === '\\') { escape = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(start, i + 1)) as ImgSourceResult
            } catch { break }
          }
        }
      }
    }

    return null
  }

  /** 将识别结果格式化为 QQ Markdown */
  function formatMd(data: ImgSourceResult, hits?: SearchHit[]): string {
    const lines: string[] = []
    lines.push('**识别结果**')
    lines.push('')
    lines.push(`**作品名：** ${data.name || '未知'}`)
    if (data.alias) lines.push(`**别名：** ${data.alias}`)
    lines.push(`**作者：** ${data.author || '未知'}`)
    if (data.tag) lines.push(`**标签：** ${data.tag}`)
    if (data.detail) {
      lines.push('```描述')
      lines.push(data.detail)
      lines.push('```')
    }
    if (data.url) {
      lines.push('')
      lines.push(`**参考链接：** ${data.url}`)
    }
    // 附带来源引擎信息
    const topHits = (hits || []).slice(0, 3)
    if (topHits.length) {
      lines.push('')
      lines.push('---')
      lines.push('**搜图引擎命中（参考）：**')
      topHits.forEach((h, i) => {
        const sim = (h.similarity * 100).toFixed(0)
        const title = h.title ? h.title : '(无标题)'
        lines.push(`${i + 1}. [${h.engine}] ${sim}% — ${title}`)
      })
    }
    return lines.join('\n')
  }

  /** 将识别结果格式化为纯文本（降级用） */
  function formatTxt(data: ImgSourceResult, hits?: SearchHit[]): string {
    const lines: string[] = []
    lines.push('【识别结果】')
    lines.push(`作品名：${data.name || '未知'}`)
    if (data.alias) lines.push(`别名：${data.alias}`)
    lines.push(`作者：${data.author || '未知'}`)
    if (data.tag) lines.push(`标签：${data.tag}`)
    if (data.detail) {
      lines.push('')
      lines.push(`描述：${data.detail}`)
    }
    if (data.url) lines.push(`链接：${data.url}`)
    const topHits = (hits || []).slice(0, 3)
    if (topHits.length) {
      lines.push('')
      lines.push('── 搜图参考 ──')
      topHits.forEach((h, i) => {
        const sim = (h.similarity * 100).toFixed(0)
        const title = h.title ? h.title : '(无标题)'
        lines.push(`${i + 1}. [${h.engine}] ${sim}% ${title}`)
      })
    }
    return lines.join('\n')
  }

  const Source = {
    /** 搜图结果，用于在展示时附带来源引擎信息 */
    _lastSearchHits: [] as SearchHit[],

    /**
     * 将搜图结果格式化为喂给 AI 的上下文文本。
     */
    formatSearchContext(hits: SearchHit[]): string {
      if (!hits.length) return ''
      const lines = ['【以图搜图结果（按相似度排序）】']
      hits.slice(0, 8).forEach((h, i) => {
        const sim = (h.similarity * 100).toFixed(1)
        const parts = [`#${i + 1} [${h.engine}] 相似度:${sim}%`]
        if (h.title) parts.push(`标题:${h.title}`)
        if (h.author) parts.push(`作者:${h.author}`)
        if (h.extra) parts.push(`备注:${h.extra}`)
        if (h.urls.length) parts.push(`链接:${h.urls.slice(0, 3).join(' | ')}`)
        lines.push(parts.join(' | '))
      })
      return lines.join('\n')
    },

    /** 通过传入的图片获得出处，返回解析后的结构化数据 */
    async getImgSourceByDeepseekApi(
      imgs: string[],
      fn?: (err: string) => Promise<void> | void
    ): Promise<ImgSourceResult | null> {
      try {
        if (!imgs?.length) {
          fn && await fn('请插入图片！')
          return null
        }

        // 1. 将QQ图片存入图床，搜图引擎需要公开可访问的 URL
        const localImg: string[] = []
        for (const url of imgs) {
          const img = await downLoad.imageHosting(url)
          img && localImg.push(img)
        }

        if (!localImg.length) {
          fn && await fn('图片上传失败，请稍后重试！')
          return null
        }

        // 2. 先跑以图搜图（SauceNAO + trace.moe）
        const searchHits = await reverseSearch.searchAll(localImg)
        Source._lastSearchHits = searchHits
        const searchContext = Source.formatSearchContext(searchHits)

        // 3. 构建发给 DeepSeek 的消息
        const userText = searchContext
          ? `${searchContext}\n\n以上是以图搜图引擎返回的参考结果（可能不完整或有误）。请你结合图片内容和这些参考结果，综合判断图片的真实出处、作者和作品名等信息，整理为 JSON 返回。如果搜图结果明显错误，请以你对图片的理解为准。`
          : `请识别以下图片的出处、作者和作品名等信息（漫画片段找到漫画名，插画找到插画的标题，cosplay找到扮演者）。注意：由于没有搜图结果，请基于你对图片的理解尽力回答。`

        const data = {
          model: config.model || "deepseek-flash",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `你是一个专业的图片出处识别助手。你会收到一张图片，以及可能附带的"以图搜图"参考结果。
你的任务是综合图片内容和参考结果，判断图片的出处信息。

你必须且只能返回一个合法的 JSON 对象，不要输出任何其他内容（包括解释、说明、markdown 代码块标记等）。

JSON 必须包含以下字段：
- name: 作品名（字符串，如无则填"未知"）
- alias: 别名（字符串，若有则填入，例如日语、英语、罗马音；若无则填空字符串""）
- author: 作者（字符串，如无则填"未知"）
- tag: 图片类型、关键字、分类（字符串）
- detail: 图片的详细描述，以及你的判断依据（字符串）
- url: 图片来源地址或参考地址（字符串，多个相关参考地址使用英文逗号 , 分割。如无可填"未知"）

所有字段值必须是字符串类型。不要输出数组，不要输出嵌套对象。`
            },
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                ...localImg.map((i) => ({ type: "image_url" as const, image_url: { url: i } })),
              ]
            }
          ]
        }

        config.deBug && console.log('[Source] 请求数据:', JSON.stringify(data, null, ' '))

        const result = await ctx.http.post(config.baseUrl + '/chat/completions', data, {
          headers: { "Authorization": 'Bearer ' + config.token, api_key: config.token, 'Content-Type': 'application/json' }
        })

        config.deBug && console.log('[Source] 原始响应:', JSON.stringify(result, null, ' '))

        const rawContent = result?.choices?.[0]?.message?.content || ''
        if (!rawContent) {
          fn && await fn('大肥鱼正在懵圈中...请稍后重试！')
          return null
        }

        const parsed = extractJson(rawContent)
        if (!parsed) {
          config.deBug && console.log('[Source] JSON 解析失败，原始内容:', rawContent)
          fn && await fn('解析返回结果失败，请稍后重试！')
          return null
        }

        return parsed
      } catch (error) {
        console.log('[Source] 请求出错:', error)
        fn && await fn('请求失败，稍后再试！')
        return null
      }
    }
  }

  const downLoad = {
    async image(
      input: string,
      upath = path.join(ctx.baseDir, config.downloadPath),
    ): Promise<string> {
      if (!fs.existsSync(upath)) {
        fs.mkdirSync(upath, { recursive: true })
      }
      const timestamp = Date.now()
      // 图片为 Base64
      if (input.startsWith('data:image/')) {
        const match = input.match(/^data:image\/(\w+);base64,(.+)$/)
        if (!match) {
          throw new Error('无效的 base64 图片格式')
        }
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
        const base64 = match[2]
        const imagePath = path.join(upath, `${timestamp}.${ext}`)
        await fs.promises.writeFile(imagePath, Buffer.from(base64, 'base64'))
        return pathToFileURL(imagePath).href
      }
      // 图片为 Url
      if (input.startsWith('http://') || input.startsWith('https://')) {
        const imagePath = path.join(upath, `${timestamp}.jpg`)
        const response = await ctx.http.get(input, { responseType: 'stream' })
        const writer = fs.createWriteStream(imagePath)
        const responseNodeStream = stream.Readable.fromWeb(response)
        responseNodeStream.pipe(writer)
        return new Promise((resolve, reject) => {
          writer.on('finish', () => {
            resolve(pathToFileURL(imagePath).href)
          })
          writer.on('error', reject)
          responseNodeStream.on('error', reject)
        })
      }
      throw new Error('参数必须是图片 URL 或 data:image base64')
    },
    async base64(imgUrl: string) {
      try {
        const res = await ctx.http.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 10000
        })
        const buffer = Buffer.from(res)
        const base64 = buffer.toString('base64')
        return `data:image/png;base64,${base64}`
      } catch (err) {
        ctx.logger.error('图片拉取失败', err)
        return null
      }
    },
    /** 图床 */
    async imageHosting(url: string): Promise<string> {
      try {
        const result = await ctx.http.post('https://img.smmcat.top/proxy/image', { url })
        if (result.code == 0) {
          return result.localUrl
        } else {
          console.log(result.error);
          return ''
        }
      } catch (error) {
        console.log(error);
        return ''
      }
    }
  }

  ctx
    .command('查出处 <img:text>')
    .action(async ({ session }, img) => {
      const userId = session.userId

      // 节流：如果该用户已有进行中的请求，直接拒绝
      if (userId && pendingUsers.has(userId)) {
        await Chat.send(session, `<@${userId}> 上次请求还在处理中，请稍等片刻后再试～`)
        return
      }

      let imgs = h.select(img, 'img').map((i) => i.attrs.src)
      if (!imgs.length) {
        // 二次获取图片信息
        Chat.send(session, `<@${userId}> 请在 30s 向我发送图片...`)
        const msg = await session.prompt(30000)
        if (msg == undefined) return
        imgs = h.select(msg, 'img').map((i) => i.attrs.src)
        if (!imgs.length) return
      }

      // 标记该用户请求中
      if (userId) pendingUsers.add(userId)


      try {
        await Chat.send(session, `<@${userId}>  稍等，大肥鱼正在给你找...`)
        const result = await Source.getImgSourceByDeepseekApi(imgs, async (err) => {
          await Chat.send(session, `<@${userId}>  ` + err)
        })

        if (result) {
          const hits = Source._lastSearchHits
          const mdContent = formatMd(result, hits)
          const txtContent = formatTxt(result, hits)
          if (Chat.isUseMd(session)) {
            await Chat.send(session, `<@${userId}>  ` + mdContent)
          } else {
            await Chat.send(session, txtContent)
          }
        }
      } finally {
        if (userId) pendingUsers.delete(userId)
      }
    })
}
