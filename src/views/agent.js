/* MCP 命令总线：把后端转来的工具调用交给 agent-tools 执行，再把结果递回去。
 *
 * 应用启动时把工具表注册给 Rust；之后每个 tools/call 都是一条 mcp-command 事件。
 * 执行过程中用户照样能操作，动作层自己会处理「镜头让位」这类事。 */

import { TOOL_LIST, runTool } from "./agent-tools.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let started = false;

export async function initAgent() {
  if (started) return;
  started = true;

  try {
    await listen("mcp-command", async (event) => {
      const { requestId, tool, args } = event?.payload || {};
      if (!requestId || !tool) return;
      const result = await runTool(tool, args);
      try {
        await invoke("mcp_reply", { requestId, payload: result });
      } catch (error) {
        console.error(`[mcp] 回复 ${tool} 的结果失败：${error}`);
      }
    });
  } catch (error) {
    console.error(`[mcp] 监听命令失败：${error}`);
  }

  try {
    const info = await invoke("mcp_register_tools", { tools: TOOL_LIST });
    console.log(`[mcp] 已注册 ${info?.count ?? TOOL_LIST.length} 个工具`);
  } catch (error) {
    console.error(`[mcp] 注册工具失败：${error}`);
  }
}
