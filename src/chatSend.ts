/**
 * 内容发送模块（Markdown 优先 + 纯文本降级）
 *
 * 功能定位：
 * - 统一封装向 QQ 平台发送消息：优先走 QQ 官方 Markdown 接口（useMd=true），
 *   失败或非 QQ 平台时降级为纯文本 fallbackText。
 *
 * 核心算法（msg_seq 递增）：
 * - QQ 平台限制同一 msg_id 的被动回复次数；本模块以 msg_id 为键维护计数，
 *   连续发送时递增 msg_seq；超过 5 次后尝试切换到 middleware 捕获的最新
 *   messageId，仍不可用则直接降级发纯文本。
 *
 * 注意事项：
 * - 私聊场景会先移除 <qqbot-at-user> 标签（私聊不支持 @）。
 * - chache/messageIdTemp 为有界内存缓存（分别 40/150 条，FIFO 淘汰）。
 * - 调用方应同时提供 Markdown 内容与等价纯文本，保证降级后信息不丢失。
 */
import { Context, Session } from "koishi"
import { Config } from "."
import { QQKeyboard } from "./keyboards"


type PassiveSource =
    | { type: 'msg_id', id: string, payload: { msg_id: string } }
    | { type: 'event_id', id: string, payload: { event_id: string } }

/** 内容发送模块 */
export const Chat = {
    config: {} as Config,
    ctx: {} as Context,
    chache: {} as Record<string, number>,
    // message 事件缓存：userId -> msg_id
    messageIdTemp: {} as Record<string, string>,
    // 按钮事件缓存：userId -> event_id
    buttonEventIdTemp: {} as Record<string, string>,

    async init(config: Config, ctx: Context) {
        Chat.config = config
        Chat.ctx = ctx
        // 普通消息事件：缓存 msg_id
        ctx.on('message', (session) => {
            if (!session.userId || !session.messageId) return

            Chat.messageIdTemp[session.userId] = session.messageId
            Chat.clearMessageIdTemp()
        }, true)

        // 按钮事件：缓存 event_id
        ctx.on('interaction/button', (session) => {
            const eventId = session.event?._data?.id
            if (!session.userId || !eventId) {
                Chat.config.deBug && console.log('[Chat] button interaction has no event_id:', session.event?._data)
                return
            }
            Chat.buttonEventIdTemp[session.userId] = eventId
            Chat.clearButtonEventIdTemp()
            Chat.config.deBug && console.log('[Chat] cached button event_id:', eventId)
        })
    },

    /**
     * 发送消息（Markdown 优先，失败自动降级）。
     */
    async send(session: Session, content: string, keyboard?: QQKeyboard): Promise<any> {
        const fallbackText = content
        if (session.platform !== 'qq') {
            await session.send(fallbackText)
            return { sent: true, mode: 'text' }
        }

        if (!Chat.config.useMd) {
            await session.send(fallbackText)
            return { sent: true, mode: 'text' }
        }

        const userId = session.userId
        let source = Chat.getCurrentPassiveSource(session)

        if (!source) {
            Chat.config.deBug && console.log('[Chat.send] no msg_id/event_id, fallback to text')
            await session.send(fallbackText)
            return { sent: true, mode: 'text' }
        }

        const cacheKey = Chat.getCacheKey(source)

        if (Chat.chache[cacheKey] == undefined) {
            Chat.chache[cacheKey] = 0
        }

        let seq = ++Chat.chache[cacheKey]
        let msgSeq = seq === 1 ? 0 : seq

        if (seq > 1) {
            Chat.config.deBug && console.log(`检测到 MD 连续发送，尝试递增 msg_seq；当前第 ${seq} 次。`)
        }

        // QQ 被动 Markdown 有次数上限，超过后尝试切换新的 msg_id / event_id
        if (seq > 5) {
            const nextSource = Chat.getNextPassiveSource(userId, source)
            if (nextSource) {
                source = nextSource
                const nextCacheKey = Chat.getCacheKey(source)
                if (Chat.chache[nextCacheKey] == undefined) {
                    Chat.chache[nextCacheKey] = 0
                }
                const nextSeq = ++Chat.chache[nextCacheKey]
                msgSeq = nextSeq === 1 ? 0 : nextSeq
                Chat.config.deBug && console.log(`[Chat.send] 被动 MD 超过上限，切换到 ${source.type}: ${source.id}`)
            } else {
                await session.send(fallbackText)
                Chat.clearChache()
                return { sent: true, mode: 'text' }
            }
        }

        const mdContent = {
            ...source.payload,
            msg_type: 2,
            msg_seq: msgSeq,
            markdown: {
                content
            },
            ...(keyboard ? { keyboard } : {})
        }

        try {
            if (session.guildId) {
                await session.bot.internal.sendMessage(session.channelId, mdContent)
            } else {
                mdContent.markdown.content = mdContent.markdown.content.replace(/<qqbot-at-user[^>]*\/>/g, '')
                await session.bot.internal.sendPrivateMessage(session.userId, mdContent)
            }

            Chat.clearChache()
            return { sent: true, mode: 'markdown' }
        } catch (error) {
            Chat.config.deBug && console.log('[Chat.send] Markdown 发送失败，回退普通文本', error)

            try {
                await session.send(fallbackText)
                Chat.clearChache()
                return { sent: true, mode: 'text' }
            } catch {
                Chat.clearChache()
                throw new Error('消息发送失败')
            }
        }
    },

    // 当前 session 是否可以使用 MD
    isUseMd(session: Session) {
        if (session.platform !== 'qq') return false

        const source = Chat.getCurrentPassiveSource(session)
        if (!source) return false

        const cacheKey = Chat.getCacheKey(source)

        if (Chat.chache[cacheKey] == undefined) return true
        return Chat.chache[cacheKey] <= 5
    },

    /** 优先取当前 session 的 msg_id；如果是按钮事件，则取 event_id */
    getCurrentPassiveSource(session: Session): PassiveSource | null {
        if (session.messageId) {
            return {
                type: 'msg_id',
                id: session.messageId,
                payload: {
                    msg_id: session.messageId
                }
            }
        }

        const eventId = session.event?._data?.id

        if (eventId) {
            return {
                type: 'event_id',
                id: eventId,
                payload: {
                    event_id: eventId
                }
            }
        }

        return null
    },

    /**
     * 超过被动 MD 上限时：
     * 1. 优先找 message 事件中缓存的新 msg_id
     * 2. 没有新 msg_id，再找按钮事件缓存的 event_id
     */
    getNextPassiveSource(userId: string, current: PassiveSource): PassiveSource | null {
        const cachedMessageId = Chat.messageIdTemp[userId]

        if (cachedMessageId && !(current.type === 'msg_id' && current.id === cachedMessageId)) {
            return {
                type: 'msg_id',
                id: cachedMessageId,
                payload: {
                    msg_id: cachedMessageId
                }
            }
        }

        const cachedButtonEventId = Chat.buttonEventIdTemp[userId]
        if (cachedButtonEventId && !(current.type === 'event_id' && current.id === cachedButtonEventId)) {
            return {
                type: 'event_id',
                id: cachedButtonEventId,
                payload: {
                    event_id: cachedButtonEventId
                }
            }
        }

        return null
    },

    getCacheKey(source: PassiveSource) {
        return `${source.type}:${source.id}`
    },

    /** 清除一条 msg_id/event_id 计数记录 */
    clearChache() {
        const chache = Object.keys(Chat.chache)

        if (chache.length >= 40) {
            delete Chat.chache[chache[0]]
        }
    },

    /** 清除一条 messageId 缓存 */
    clearMessageIdTemp() {
        const messageIdTempList = Object.keys(Chat.messageIdTemp)

        if (messageIdTempList.length > 150) {
            delete Chat.messageIdTemp[messageIdTempList[0]]
        }
    },

    /** 清除一条按钮 event_id 缓存 */
    clearButtonEventIdTemp() {
        const buttonEventIdTempList = Object.keys(Chat.buttonEventIdTemp)

        if (buttonEventIdTempList.length > 150) {
            delete Chat.buttonEventIdTemp[buttonEventIdTempList[0]]
        }
    }
}

