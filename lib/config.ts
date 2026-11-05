// 注意：以下常数大多是未经数据校准的初始猜测值（见 RPD「0.8 目标落在校准里」），
// 全部可通过环境变量覆盖；events 日志积累后应拟合 pass-rate-vs-R 曲线重新标定。
const num = (env: string | undefined, fallback: number) =>
  env !== undefined ? Number(env) : fallback;

export const CONFIG = {
  // 可提取度 R 的"成熟"阈值：R 低于它才值得重测（目标服务点 ≈ 0.8，留一点提前量）
  RIPE_R: num(process.env.RIPE_R, 0.9),
  // 缓存冷却闸门（双通道并联：≈H_tick 个干扰任务，或 ≈H_CACHE_MS 自然流逝）：
  // 7 个其他任务或 20 分钟任一条件满足后即可复习。
  CACHE_COLD: num(process.env.CACHE_COLD, 0.5),
  CACHE_COOLDOWN_TICKS: num(process.env.CACHE_COOLDOWN_TICKS, 7),
  // 缓存的时间通道半衰期：工作记忆痕迹自然消散 ≈ 20 分钟
  H_CACHE_MS: num(process.env.H_CACHE_MS, 20 * 60_000),
  // 严重逾期路由线：R 跌穿此值 → 提取大概率失败，绕过竞争直接回重编码（Step 1+2 式）
  RELEARN_R: num(process.env.RELEARN_R, 0.2),
  // 维护缺口：轴已达标（F ≥ target）但保持力未验证（H_time < 30d）时的小 gap——
  // 让词以低优先级留在队列里接受维护复习，直到双向 H_time 满 30d 才毕业退场
  MAINT_GAP: num(process.env.MAINT_GAP, 0.05),
  // 紧迫度增益：urgency（逾期平方项）的放大倍数。R→RELEARN_R 时紧迫因子 ≈ 1+9×0.6 ≈ 6.4
  URGENCY_GAIN: num(process.env.URGENCY_GAIN, 9),
  // 新词插空引入的绕过阈值：复习池最高 P 低于它（≈一个全新词的价值）时，插空引入新词
  NEW_WORD_BYPASS: num(process.env.NEW_WORD_BYPASS, 1.0),
  // 打分用的 R 下限：调度的设计服务点是 R ≈ 0.8（desirable difficulty），
  // 若实际服务时 R 更低（词多竞争、排队过久），视为调度迟到而非学习者遗忘，
  // 否则 EWMA 的 F·R 会把进度清零、F 收敛到 α·attempt/(1−(1−α)R̄) 而停摆。
  SCORE_R_FLOOR: num(process.env.SCORE_R_FLOOR, 0.8),
  // 流利度 EWMA 的新观测权重
  ALPHA: num(process.env.ALPHA, 0.4),
  // 半衰期种子：tick 钟 ≈ 4~5 个任务（唯一职责是缓存的干扰通道，双向共享）
  H_TICK_SEED: num(process.env.H_TICK_SEED, 4),
  // 时间钟种子 1h；成功 ×2（1h → 1d → 3d → 7d…），失败 ÷2，下限 1h
  H_TIME_SEED_MS: num(process.env.H_TIME_SEED_MS, 3_600_000),
  H_TIME_MIN_MS: num(process.env.H_TIME_MIN_MS, 3_600_000),
  // 毕业的保持力门槛：双向 H_time ≥ 30 天（证明扛住了长期遗忘）
  H_TIME_GRAD_MS: num(process.env.H_TIME_GRAD_MS, 30 * 24 * 3_600_000),
  // Part B 通关后 H_time_P 跳到的档位（1d rung）
  H_TIME_PART_B_MS: num(process.env.H_TIME_PART_B_MS, 24 * 3_600_000),
  // Part B 批次门禁：凑满 N 个双轴达 INTEGRATE_FLOOR 的未整合词触发
  BATCH_SIZE: num(process.env.BATCH_SIZE, 5),
  // 「先准确后速度」的准确性底线：F 低于它时速度任务（Step 4 / Step 4R / MFI）不可派
  ACCURACY_FLOOR: num(process.env.ACCURACY_FLOOR, 50),
  // Part B 门禁的双轴流利度底线
  INTEGRATE_FLOOR: num(process.env.INTEGRATE_FLOOR, 75),
  // Step 1+2 播种值：产出方向见过拼写并盲打成功 / 接受方向只见过拼写、再认未验证
  SEED_F_P: num(process.env.SEED_F_P, 15),
  SEED_F_R: num(process.env.SEED_F_R, 8),
  // 速度标尺（绝对尺子，目标锚定，见 RPD「目标锚定的流利度」）：
  // 写作打字模态 25 → 60 wpm（二语流利下限 → 母语者平均上限；手写 15→30 留作模态开关）
  V_FLOOR_WRITING: num(process.env.V_FLOOR_WRITING, 25),
  V_CEIL_WRITING: num(process.env.V_CEIL_WRITING, 60),
  // 阅读模态 150 → 300 wpm（能获得大部分意思的最低速度 → 母语者上限 250–300 取顶）
  V_FLOOR_READING: num(process.env.V_FLOOR_READING, 150),
  V_CEIL_READING: num(process.env.V_CEIL_READING, 300),
  // 阅读材料词数下限：低于它速读无意义（如词表导入只有语块本身），F_R 镜像 F_P
  READ_MIN_WORDS: num(process.env.READ_MIN_WORDS, 8),
  // MFI 篇章词数窗口与已知词覆盖率下限
  MFI_MIN_WORDS: num(process.env.MFI_MIN_WORDS, 150),
  MFI_MAX_WORDS: num(process.env.MFI_MAX_WORDS, 300),
  MFI_COVERAGE: num(process.env.MFI_COVERAGE, 0.95),
  // 打字类任务（Step 2/3）的目标击键速度：T_target = 该值 × 语块字符数
  T_TARGET_PER_CHAR_MS: num(process.env.T_TARGET_PER_CHAR_MS, 350),
  // 自适应速度游标：干净通过 ×1.05 向目标速度棘轮，准确性失败 ×0.90 回落（保底 v_floor）
  CURSOR_UP: num(process.env.CURSOR_UP, 1.05),
  CURSOR_DOWN: num(process.env.CURSOR_DOWN, 0.9),
  // PDF 处理：页数上限 / OCR 渲染缩放（越大越准但越慢）/ 判定扫描页的文字量阈值
  PDF_MAX_PAGES: num(process.env.PDF_MAX_PAGES, 1200),
  PDF_OCR_SCALE: num(process.env.PDF_OCR_SCALE, 2),
  PDF_TEXT_MIN_CHARS: num(process.env.PDF_TEXT_MIN_CHARS, 20),
};
