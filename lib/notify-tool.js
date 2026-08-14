// dsh-notify 模型主动通知工具 —— 把模型消息作为 kind='model-message' 通知入队，零依赖（不 import schemastery）。
// 契约：
// - 参数 schema 的单一事实源是调用方传入的 schemastery z 对象：既是 execute 里的运行时校验器，
//   又经 zToJsonSchema 投影成 dsh tools 的标准 JSON Schema 子集（object/string/boolean + required/description）；
// - execute 返回值 { sent: boolean } 与 output.schema 一致（宿主 registry 会按 schema 强校验返回值）；
// - 子会话（非根会话）调用时静默不发送并返回 sent: false，与插件「只通知根会话」语义一致；
// - 发送行为全部委托给调用方注入的 notify(message, channel, priority, session) 回调（返回是否受理）。

/**
 * schemastery z 对象 → dsh tools JSON Schema 子集（只支持本工具用到的 object/string/boolean）。
 * 输入是 schema 实例（含 type/dict/meta 运行时结构），与 schemastery 库本体解耦。
 * @param {object} schema - z 对象（{ type, dict?, meta? }）。
 * @returns {{ type: string, properties?: object, required?: string[], description?: string }} JSON Schema 节点。
 */
export function zToJsonSchema(schema) {
  const node = {}
  const description = typeof schema?.meta?.description === 'string' ? schema.meta.description : undefined
  if (description !== undefined) node.description = description
  switch (schema?.type) {
    case 'object': {
      node.type = 'object'
      const properties = {}
      const required = []
      for (const [key, inner] of Object.entries(schema.dict ?? {})) {
        properties[key] = zToJsonSchema(inner)
        if (inner?.meta?.required === true) required.push(key)
      }
      node.properties = properties
      if (required.length > 0) node.required = required
      return node
    }
    case 'string':
    case 'boolean':
      node.type = schema.type
      return node
    default:
      throw new Error(`notify: 工具参数类型 ${schema?.type ?? 'unknown'} 不受支持（仅 object/string/boolean）`)
  }
}

/**
 * 创建 notify 工具定义（供 ctx.tools.register 使用）。
 * @param {{
 *   params: object, // schemastery z 对象：参数校验器 + schema 单一事实源
 *   notify: (message: string, channel: string | undefined, priority: boolean, session: unknown) => boolean,
 *   sessionOf: (exec: object) => unknown,
 *   isRootSession: (session: unknown) => boolean,
 * }} deps
 * @returns {object} 宿主 ToolDefinition（name/description/parameters/output/execute）。
 */
export function createNotifyTool({ params, notify, sessionOf, isRootSession }) {
  return {
    name: 'notify',
    description:
      '主动给主人发送一条通知（如任务完成、需要主人关注）。message 是通知正文，将原样推送到已配置的'
      + '通知通道（webhook/语音等）；channel 可选，指定只发送到该通道 id；priority 可选，紧急消息插队发送。'
      + '注意：只有根会话的通知会真正发出。',
    parameters: zToJsonSchema(params),
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean', description: '通知是否已被受理发送' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.sent === true ? '通知已发送' : '通知未发送' }],
    },
    async execute(args, exec) {
      const { message, channel, priority } = params(args ?? {})
      const session = sessionOf(exec)
      if (session !== undefined && !isRootSession(session)) {
        return { sent: false } // 子会话：静默不发送（与触发源根会话过滤一致）
      }
      const sent = notify(message, channel, priority === true, session)
      return { sent }
    },
  }
}
