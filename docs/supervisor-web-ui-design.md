# Needs Forever 监督记录 Web UI 设计

## 目标

提供一个本地、只读、容易扫描的记录页面，让用户选择一个任务后，直接看到：

1. worker 的某一轮是如何结束的；
2. supervisor 收到了哪些关键事件；
3. supervisor 做了什么判断或恢复动作；
4. 这一轮最后是继续、等待、暂停还是完成。

页面服务于观察和追查，不承担启动、暂停、恢复等控制职责。控制仍使用现有插件命令，避免在观察页面里误触发任务变更。

## 视觉与交互方向

### 视觉主题

“安静的运行记录”：白色或浅灰工作区、深色正文、一个蓝色主色，状态颜色只用于表达结果。页面看起来像一份清楚的操作日志，而不是监控大屏。

### 内容安排

- 左侧：任务列表，帮助用户定位项目和任务。
- 中间：选中任务的工作轮次时间线，是页面主体。
- 右侧抽屉：点击某一轮后查看完整事件、证据和技术 ID。
- 顶部：当前任务的目标、状态、最近更新时间和入口路径。

### 交互动作

- 轮次逐步出现：新事件到达时，只在时间线底部追加一条，不刷新整页。
- 轮次展开：默认收起低层事件，点击后展开事件顺序和证据。
- 自动刷新开关：默认开启，显示“刚刚更新”；关闭后只读取当前快照。

## 页面结构

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Needs Forever                         [任务: demo-001]  [自动刷新 ●]        │
├───────────────┬──────────────────────────────────────────────┬─────────────┤
│ 任务           │ demo-001                                    │ 详情抽屉    │
│               │ 完成指定本地任务                             │             │
│ ● demo-001    │ 状态  ACTIVE   阶段 WORKER                  │ 轮次 #3      │
│   ACTIVE      │ 最近更新 10:32:18   worker 3 轮              │             │
│               ├──────────────────────────────────────────────┤ worker 结束 │
│ ○ demo-002    │ 过滤: [全部] [异常] [worker] [监督器]        │ 10:32:14    │
│   DONE        │                                              │             │
│               │ 10:30:02  第 3 轮                            │             │
│ ○ demo-003    │ worker 结束 → supervisor 判断 → 结果         │             │
│   WAIT_EXTERNAL│                                              │             │
│               │  worker  已完成当前步骤                        │             │
│               │  supervisor  判断 CONTINUE                    │             │
│               │  结果      已发送下一步，等待新回合开始        │             │
│               │                                              │             │
│               │ 10:32:14  第 4 轮                            │             │
│               │ worker  已开始                               │             │
│               │ supervisor  正在等待结束事件                  │             │
└───────────────┴──────────────────────────────────────────────┴─────────────┘
```

页面不使用统计卡片网格。任务状态和轮次时间线已经是用户需要的主要信息。

## 顶部任务信息

顶部只保留能帮助定位的内容：

- 任务名称：`task_id`；
- 目标：`task.goal`，最多显示两行，点击可查看完整文本；
- 状态：`ACTIVE`、`WAIT_EXTERNAL`、`PAUSED`、`DONE`；
- 阶段：`WORKER`、`JUDGE`、`VERIFY`、`RECOVERING`、`IDLE`；
- 最近更新时间；
- 工作区路径；
- worker thread ID 的短显示值，完整值放进详情抽屉。

状态文案应补充人话解释：

| 原始状态 | 页面文案 | 颜色 |
| --- | --- | --- |
| `ACTIVE` | 正在推进 | 蓝色 |
| `RECOVERING` | 正在恢复 | 琥珀色 |
| `WAIT_EXTERNAL` | 等待外部条件 | 紫色 |
| `PAUSED` | 已暂停 | 灰色 |
| `DONE` | 已完成 | 绿色 |

`phase` 只作为小字辅助信息，不应比任务状态更醒目。

## 时间线的核心单位：工作轮次

不要把每条 JSONL 事件直接平铺成列表。页面先把事件聚合成“工作轮次”，每个轮次显示三列：

| 区域 | 内容 |
| --- | --- |
| 发生了什么 | worker 的 turn 开始、结束、失败或中断 |
| supervisor 怎么处理 | 判断、重试、恢复、验收、发送下一步 |
| 结果 | `CONTINUE`、`DONE`、`WAIT_EXTERNAL`、暂停或待确认 |

一条轮次记录的默认文案示例：

```text
第 3 轮 · 10:30:02–10:32:14

发生了什么
worker 完成了一轮工作

supervisor 怎么处理
判断为 CONTINUE，并发送“先修复 verifier，再重新运行验收”

结果
下一轮已确认开始
```

如果发生错误，直接显示可操作的结论：

```text
发生了什么
worker 回合结束，但发送结果不明确

supervisor 怎么处理
已重新连接并核对原 worker 历史，没有直接重复发送

结果
等待历史核对完成；下一次重试时间 10:35:00
```

## 轮次展开内容

点击轮次后，在右侧抽屉显示按时间排序的关键事件。默认使用人话标签，原始事件名放在灰色小字中。

| 原始事件 | 人话标签 | 默认是否显示 |
| --- | --- | --- |
| `worker_started` | worker 开始工作 | 是 |
| `worker_completed` | worker 完成一轮 | 是 |
| `decision` | supervisor 判断 | 是 |
| `send_prepared` | 已准备下一步 | 是 |
| `send_confirmed` | 下一轮已确认开始 | 是 |
| `verification_result` | 独立验收结果 | 是 |
| `recovery_retry_scheduled` | 已安排恢复重试 | 是 |
| `external_wait_required` | 进入外部等待 | 是 |
| `recovery_required` | 需要恢复 | 是 |
| `worker_output` | worker 输出 | 点击后显示 |
| `server_request` / `server_request_answered` | 请求与处理 | 点击后显示 |
| `stale_*` | 迟到事件已忽略 | 异常过滤或展开后显示 |
| `connection_*` | 连接状态 | 技术详情 |

每条事件只显示四个字段：时间、角色、简短说明、结果。完整 JSON、thread ID、turn ID、delivery ID 和 snapshot ID 放在“技术详情”折叠区。

## supervisor 判断的重点展示

`decision` 事件不直接展示 JSON，而是转成三种固定结果：

- **继续**：显示下一步指令的摘要，以及是否已经确认新 worker 回合；
- **完成**：显示完成理由、引用的证据和独立验收是否通过；
- **等待外部条件**：显示缺失条件、已经尝试的路线、为什么当前没有其他工作可做、恢复要求。

对于 `DONE`，页面必须同时显示：

```text
判断：完成
独立验收：通过 / 失败 / 未配置
受保护文件：未修改 / 有修改
```

这样用户能区分“judge 说完成”和“验收确实通过”。

## 异常与等待

异常不做红色满屏告警，只在对应轮次里显示一条浅色提示：

- 重试：`下一次重试：10:35:00`；
- 外部等待：`缺少：……；恢复方式：……`；
- 暂停：`用户于 10:36:12 暂停`；
- 迟到结果：`该结果已过期，没有改变任务状态`。

顶部状态保持稳定，用户滚动时间线时不会被弹窗打断。

## 任务列表

任务列表只显示本地可发现的任务记录：

- task_id；
- 人话状态；
- 最近更新时间；
- 最后一条结果摘要。

排序默认按最近更新时间倒序。不要在第一版加入项目统计、趋势图、复杂筛选或多任务批量控制。

## 数据读取接口

第一版直接读取现有任务目录，不新增数据库：

```text
<workspace>/.codex-supervisor/<task_id>/state.json
<workspace>/.codex-supervisor/<task_id>/events.jsonl
<workspace>/.codex-supervisor/<task_id>/summary.md
<workspace>/.codex-supervisor/<task_id>/snapshots/*
```

建议拆成三个内部模块：

1. `TaskCatalog`：发现任务目录，读取 `state.json`，生成左侧任务列表；
2. `EventReader`：增量读取 `events.jsonl`，按任务版本和轮次组织事件；
3. `RecordPresenter`：将原始事件转换为页面使用的人话记录。

Web 层只依赖一个小接口：

```ts
type TaskRecord = {
  taskId: string;
  state: TaskStateView;
  rounds: WorkRound[];
  updatedAt: string;
};

type WorkRound = {
  id: string;
  startedAt: string;
  endedAt?: string;
  worker: HumanEvent;
  supervisor: HumanEvent[];
  result: HumanEvent;
  technicalEvents: TechnicalEvent[];
};
```

这个接口把文件格式和页面解耦；后续如果改成读取远端或 SQLite，页面不需要重写。

## 本地服务形态

- 只监听 `127.0.0.1`；
- 默认只读；
- 首版用 1 秒轮询或文件修改时间检查，不引入 WebSocket；
- 浏览器刷新后仍从持久文件恢复；
- 原始日志只在用户主动展开时读取和展示；
- 不把任务内容发送到外部服务。

建议入口：

```text
http://127.0.0.1:<port>/
http://127.0.0.1:<port>/tasks/<task_id>
```

## 第一版验收

- 能看到至少一个任务，并显示当前 `status` 与 `phase`；
- 选中任务后，页面按时间显示 worker 结束、supervisor 判断和结果；
- `CONTINUE` 能看见下一步指令摘要，以及 `send_confirmed` 是否发生；
- `DONE` 能同时看到 judge 结论和独立验收结果；
- `WAIT_EXTERNAL` 能看到缺失条件和恢复要求；
- 重试、连接恢复、迟到事件会显示为记录，不能被吞掉；
- 点击某一轮可以看到原始事件和 thread/turn/delivery/snapshot ID；
- 页面只读，不能改变任务状态；
- 关闭并重新打开浏览器后，记录仍来自同一份持久文件；
- 不需要引入数据库、登录系统、图表库或复杂前端框架。

## 实现入口

记录页面已接入监督器 CLI 和插件运行包。开发 checkout 使用：

```text
node dist/src/cli.js web --workspace <绝对工作区路径> --port 8787
```

已安装插件使用：

```text
node <插件>/scripts/control.mjs web --workspace <绝对工作区路径> --port 8787
```

服务只监听 `127.0.0.1`，提供 `GET /api/tasks`、`GET /api/tasks/<task_id>` 和只读页面路由。页面按 `turn_id` 聚合事件，事件卡片先显示原始枚举值，再显示简短说明；点击轮次后展开完整事件、thread/turn/delivery/snapshot ID 和原始 JSON。自动刷新默认开启，所有数据仍来自任务目录中的持久文件。

## 暂不放入第一版

- 启动、暂停、恢复按钮；
- 多用户权限；
- 远程访问；
- 任务之间的统计图；
- 自动摘要模型；
- 复杂的事件搜索语言；
- 直接编辑任务合同或验收命令。
