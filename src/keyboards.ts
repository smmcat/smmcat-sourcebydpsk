/**
 * QQ Markdown 下挂按钮（keyboard）组件
 *
 * 结构、样式与交互规范来自 robloxmdbutton.md / QQ_MARKDOWN_BUTTON_GUIDE.md：
 * - action.type：0 链接 / 1 回调 / 2 指令
 * - render_data.style：0 灰线框 / 1 蓝线框 / 2 蓝底 / 3 红色警示 / 4 主操作
 * - permission.type：0 指定用户 / 1 管理者 / 2 所有人
 * - 每行最多 4 个按钮，最多 5 行
 */

export interface QQButtonRenderData {
    label: string
    visited_label?: string
    style: 0 | 1 | 2 | 3 | 4
}

export interface QQButtonPermission {
    type: 0 | 1 | 2
    specify_user_ids?: string[]
}

export interface QQButtonAction {
    type: 0 | 1 | 2
    permission: QQButtonPermission
    data: string
    enter?: boolean
    reply?: boolean
    unsupport_tips?: string
}

export interface QQButton {
    id?: string
    render_data: QQButtonRenderData
    action: QQButtonAction
}

export interface QQKeyboardRow {
    buttons: QQButton[]
}

export interface QQKeyboard {
    content: {
        rows: QQKeyboardRow[]
    }
}

const UNSUPPORT_TIPS = '请升级QQ版本'

/** 指令按钮（action.type=2）：以点击者身份发送指令 */
export function cmdButton(
    label: string,
    data: string,
    style: QQButtonRenderData['style'] = 0,
    permission: QQButtonPermission = { type: 2 },
    visitedLabel = label,
    enter = true,
): QQButton {
    return {
        render_data: { label, visited_label: visitedLabel, style },
        action: { type: 2, permission, data, enter, unsupport_tips: UNSUPPORT_TIPS },
    }
}

/** 回调按钮（action.type=1）：触发 interaction/button 事件 */
export function callbackButton(
    label: string,
    data: string,
    style: QQButtonRenderData['style'] = 0,
    permission: QQButtonPermission = { type: 2 },
    visitedLabel = label,
    id?: string
): QQButton {
    return {
        id,
        render_data: { label, visited_label: visitedLabel, style },
        action: { type: 1, permission, data, unsupport_tips: UNSUPPORT_TIPS },
    }
}

/** 链接按钮（action.type=0） */
export function linkButton(
    label: string,
    url: string,
    style: QQButtonRenderData['style'] = 0,
): QQButton {
    return {
        render_data: { label, visited_label: label, style },
        action: { type: 0, permission: { type: 2 }, data: url, unsupport_tips: UNSUPPORT_TIPS },
    }
}

export function keyboard(...rows: QQButton[][]): QQKeyboard {
    return { content: { rows: rows.map((buttons) => ({ buttons })) } }
}
