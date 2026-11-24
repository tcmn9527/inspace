/* 主窗口到后端 AI 助手能力的薄封装。Key 只由设置窗口读写，主面板拿到的
   配置里 key 字段是脱敏后的占位符，不会出现在 DOM 或 localStorage。 */

const { invoke } = window.__TAURI__.core;

/* 主面板只读脱敏状态；设置窗口才拿完整配置（含 Key）。 */
export const assistantApiGet = () => invoke("assistant_api_status");
export const assistantApiConfig = () => invoke("assistant_api_get");
export const assistantApiSet = (config) => invoke("assistant_api_set", { config });
export const assistantModels = (config) => invoke("assistant_models", { config });
export const assistantModelVision = (model) => invoke("assistant_model_vision", { model });
export const assistantChat = (payload) =>
  invoke("assistant_chat", {
    messages: payload.messages,
    tools: payload.tools || [],
    session: payload.session || "",
  });

/* 只置后端那个取消开关：正在读的流会在下一行到达时收住，
   已经发出去的那一段服务端照样跑完。 */
export const assistantCancel = () => invoke("assistant_cancel");
