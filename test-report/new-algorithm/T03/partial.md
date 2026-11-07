# T03 部分实现证据

- 日期：2026-11-07。使用独立新库临时文件；未操作 `flow.db`。
- 命令：`node test/run-new-algorithm-db-tests.cjs`，退出 0，13/13；新增 2 项为 T03 导入/词义测试。
- 输入：无初分、R=59.9、R=60、目标 P=59/100、带/不带 freq_source、未确认空词义、确认与修改词义。
- 期望/实际：默认目标 R/P=80、无初分为 0、合法初分保留且 observation=0；非法目标/初分/频率来源批次无任何写入。未确认词义保留为空；明确确认后提升 meaning_version，修改后旧材料标记 invalidated。
- DB 快照：合法导入后 `score_r=59.9,score_p=0,target_r=80,target_p=100,observation_r=observation_p=0,level=B1,freq_source=book`；三个非法批次后词数仍为 1。gloss 从空→河岸→银行，版本 1→2→3，旧版本材料 `ready→invalidated`。
- 未完成：正式 goals API/page 接入、ENCODE/choice 材料生成与校验、后台作业/预算、材料使用记录、真实 AI 和人工样本。T03 保持 IN_PROGRESS，不能据此验收 V01。
