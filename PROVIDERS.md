# 供应商接入与联调

新增供应商表单用图标表示预设的实测状态。悬停或聚焦图标可以查看说明。有上游账号的用户可在供应商详情的「连通性测试」中选择协议、填写上游 Key 与模型 ID，确认该组合能否调用。

反馈请提交到公开仓库的 GitHub Issues，注明 LutraGate 版本、预设名称和地域、协议、模型 ID，以及连通性、流式、模型发现各自的通过、失败或未测结果。只提交脱敏后的错误类别和状态码。API Key、请求头、请求内容和私有部署地址留在自己的环境内。[提交联调反馈](https://github.com/BeaversLab/LutraGate/issues)

## 静态模型候选

模型发现可用时优先使用当前账号的模型列表。接口没有提供或拉取失败时，使用预设候选，也可以手填上游模型 ID。维护候选时按站点和套餐核对官方目录，保留供应商文档中的完整 ID，包含命名空间、大小写或版本后缀。

- 国内渠道参考 [智谱普通 API](https://docs.bigmodel.cn/cn/guide/start/quick-start)、[智谱 Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/faq)、[百炼地域与模型能力](https://help.aliyun.com/en/model-studio/qwen3-8-flash)、[Kimi 国内开放平台](https://platform.kimi.com/docs/get-api-key)、[火山方舟模型列表](https://console.volcengine.com/ark/region:cn-beijing/docs/model-list) 和 [AgentPlan 模型公告](https://console.volcengine.com/ark/region:cn-beijing/docs/agent-plan-personal-model-release)。
- 国际渠道参考 [OpenAI](https://developers.openai.com/api/docs/models)、[Claude](https://platform.claude.com/docs/en/models/overview)、[Gemini](https://aistudio.google.com/docs/models)、[Groq](https://console.groq.com/docs/models)、[Mistral](https://docs.mistral.ai/models)、[Grok](https://docs.x.ai/developers/models/grok-4.7) 和 [SiliconFlow 国际模型列表接口](https://docs.siliconflow.com/en/api-reference/models/get-model-list)。

## 套餐端点

套餐、普通 API 与不同地域分别记录，以下套餐端点供后续适配核对。连通性测试与网关转发都需要满足对应套餐的使用范围和客户端要求。

| 供应商 | 套餐 | 官方 OpenAI Chat Completions Base URL | 本轮状态 |
| --- | --- | --- | --- |
| 智谱 | 国内 GLM Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4` | 已有预设。[官方说明](https://docs.bigmodel.cn/cn/coding-plan/quick-start) |
| Z.ai | 国际 GLM Coding Plan | `https://api.z.ai/api/coding/paas/v4` | 待确认网关测试与转发是否属于支持范围。[官方端点](https://zcode.z.ai/en/docs/configuration) · [套餐 FAQ](https://docs.z.ai/devpack/faq) |
| Kimi | Kimi Code 国内、国际 | `https://api.kimi.com/coding/v1`、`https://api.kimi.ai/coding/v1` | 待验证真实客户端标识要求，以及网关测试方式。[官方说明](https://www.kimi.com/code/docs/en/) |
| 阿里云百炼 | 国内、国际 Coding Plan | `https://coding.dashscope.aliyuncs.com/v1`、`https://coding-intl.dashscope.aliyuncs.com/v1` | 官方将套餐用于交互式编程工具。普通按量预设已加入目录。[官方说明](https://help.aliyun.com/en/model-studio/base-url) |
| 阿里云百炼 | 北京、新加坡 Token Plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`、`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | 官方将套餐用于交互式编程工具。普通按量预设已加入目录。[官方说明](https://help.aliyun.com/en/model-studio/base-url) |
| 腾讯云 | 广州、新加坡 Token Plan | `https://tokenhub.tencentmaas.com/plan/v3`、`https://tokenhub-intl.tencentmaas.com/plan/v3` | 待确认套餐调用要求。普通按量预设已加入目录。[官方说明](https://cloud.tencent.com/document/product/1823/130659) |
| MiniMax | Token Plan | 按站点、套餐指南确认具体推理端点 | 待核对请求与配额查询。套餐 Key 和按量 Key 分别管理。[套餐说明](https://platform.minimax.io/protocol/paid-agreement) |
