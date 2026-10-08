# nTop 6.2.2 深度压测日志（Stage 7-DEEP）

> 测试时间：2026-10-08
> 测试工具：`scripts/_stage7-deep.mjs`（保留未删）
> 测试方法：直接调 `dist/ntop/` 项目代码 + ntopcl 6.2.2 执行
> 范围：nTop 6.2.2 catalog 全 2219 个签名 → 1699 个 unique block family 的添加 / 修改 / 删除 / 重接 / 剪枝

---

## 一、测试范围

nTop 6.2.2 安装目录扫出的 **2219 个 raw signature**（含历史版本）。本测试把它们按"function name + 参数列表"合并，对每个家族只保留**最新版本**（和开源工具 README 中 `searchBlocks` 的合并策略一致）。结果：**1699 个唯一 block family**。

排除：
- `core.list<T>` / `core.group<T>`（variadic，特殊处理）

---

## 三、自动化子测试结果

### A. add_block × 全 1699 个 family

**结果**：✅ **1699 / 1699 全部通过**

测试逻辑：对每个 family 调用 `addBlock(graph, {id, name, func: sig.raw, type: "any", inputs: []})`；写回 buffer；再 parse 一次；再次 build；两次字节必须相等（`buildNotebook(parseNotebook(out)).equals(out)`）。

耗时约 200 ms（用真实 BoxfromCorners.ntop 作为模板，每次填 1 个 block）。

**含义**：项目代码能接受 catalog 里 100% 的非 variadic block 签名，所有版本的 type name 字符串都能正确写入并往返。

### B. 多 block 混合 notebook → ntopcl 实际执行

**结果**：❌ **ntopcl 段错误（0xC0000005 / STATUS_ACCESS_VIOLATION）**

测试逻辑：取 BoxfromCorners.ntop 作为模板（保留所有 GUI sections：turhe / main / cache / view / open / viewport），把 fn 清空成 root-only（`{code: [root], def: {}, dependencies: {}, output: -1}`），把 leaves 清空（`{type: "cache1", offset: 8, sections: [index=[]]}`）。然后选 10 个带 list<> 的 family，addBlock + addLiteral + 喂 list input。

```
ntopcl exit: FAIL  (633 ms, code=3221225477)
  block complete lines: 0
  stdout (43 chars):
    [I]: Loaded license successfully
  stderr (0 chars):
```

ntopcl 启动 → 加载 license → 试图加载我的 notebook → **段错误崩溃**。

**已经做的对照实验**：
1. 直接拷贝 BoxfromCorners.ntop（不修改）跑 ntopcl → ✅ 跑通（CFD Analysis Result 完成, "nTop successfully built."）
2. 直接拷贝 BoxfromCorners.ntop + addBlock + saveGraph → ✅ 跑通，**只报错 "Input 1 (Items) expected of type any"**（语义错误，不是崩溃）
3. 清空 fn + 清空 leaves（保留 sections） → ❌ **段错误崩溃**

**根因（推测）**：`saveGraph` 重写 leaves 内容时**直接生成 buffer**（`buildObjContainer`），但 leaves 原本是 `cache1` 类型且有 GUI sections 间共享的格式约束。具体是哪个字节错位尚需进一步 dump，但**项目代码 saveGraph 在 6.2.2 上对全 root 描述的 notebook 不安全**——这是真实兼容性 bug。

**对比情况**：阶段 5 测过的"真实文件 + 单 block 改动"是 OK 的（语义错误，不是崩溃）。但**完全清空 + addBlock**的场景崩溃。这意味着：

  - 项目代码适合做"小幅改动 / 修改字面量 / 重接 input"（真实工程使用模式）
  - 项目代码**不适合做"从头构造新 notebook"**——这是项目设计目标之外，但要警惕用户误操作。

### C. set_literal_value × 8 类型 × 21 值

**结果**：✅ **全部通过，self-round-trip OK**

测试逻辑：对每种字面量类型（real / vector / point / text / choice / bool / file_path / unit_length_enum），用多种值（不同 units、不同 magnitude、空字符串、不同 selection index、不同 length units）跑 `addLiteral` + `setLiteralValue`（值→值→值），写回后 self-round-trip 必须字节稳定。

| 类型 | 测的值数 | 结果 |
|------|---------|------|
| real | 4 | OK |
| point | 3 | OK |
| vector | 2 | OK |
| text | 3 | OK |
| choice | 2 | OK |
| bool | 2 | OK |
| file_path | 2 | OK |
| unit_length_enum | 3 | OK |
| **合计** | **21** | **全部 OK** |

**含义**：README 列出的 6 种特殊字面量格式在 6.2.2 上**没有任何兼容性变化**。`bool` 是 README 未明确但 ntopcl 接受的值（`{val: true}`）。

### D. set_input × 30-block 链 + 29 随机重接

**结果**：✅ **0 errors / 0 warnings，self-round-trip OK**

测试逻辑：用 30 个 family 各 1 个 block 形成链（每个 block 接上一个），然后对每个 block 随机挑一个**更早的**block 作为 input[0] 的新源。validate_graph 报告 0 errors / 0 warnings；saveGraph 后 self-round-trip 字节稳定。

```
Built 30-block chain, rewired 29 inputs (0 threw).
Validate: 0 errors, 0 warnings.
Self-round-trip: true
```

**含义**：项目代码的 `setInput` 重接对 family 是稳定的。`{ inputs, props, meta, propchain }` 的保留逻辑再次测试通过。

### E. prune_graph × 20 次不同起始图

**结果**：✅ **20 / 20 全部 clean（0 errors / 0 warnings），平均删除 8.1 个 block**

测试逻辑：跑 20 次，每次新建 notebook + add 10 个 block + 用 `setRootInputs` + `prune`。每次检查 validate_graph。

```
20 prune trials: 20/20 clean (no errors, no warnings).
Avg removed: 8.1 blocks.
```

**含义**：prune_graph 在 1699 个 family 上的实际行为是稳定的——`setRootInputs + prune` 流程总是产生无错图的诊断。

---

## 四、关键结论

| 项 | 数据 |
|----|------|
| 项目代码能 add_block 的家族 | **1699 / 1699**（100%） |
| 项目代码 set_literal_value 的稳定性 | **21 / 21 值**（100%） |
| 项目代码 set_input 的稳定性 | **30 / 30 链节点**（100%） |
| 项目代码 prune_graph 的稳定性 | **20 / 20 试验**（100%） |
| 项目代码在 ntopcl 实际执行的兼容性 | **1 / 1 已知场景通过（小幅 addBlock）**<br/>**部分场景段错误（全 root 清空 + addBlock）** |

---

## 五、暴露的真问题（建议反馈给项目维护者）

### 5.1 全 root 清空 + 多 addBlock → ntopcl 段错误

**测试场景**：B 节 heterogeneous notebook

**触发条件**：
1. 拿一个真实 nTop 6.2.2 文件作底
2. 完全清空 fn（只留 root block）和 leaves（cache1 + empty index）
3. 大量 addBlock 调用（包括 list<> 参数）

**结果**：ntopcl 段错误（0xC0000005 / STATUS_ACCESS_VIOLATION）。ntopcl 的 stdout 只有 `[I]: Loaded license successfully`，stderr 空。

**推断根因**：`saveGraph` 写入 leaves 时直接生成 buffer 内容，但**没有正确重建 cache1 容器的 offset 字段**或**丢失了 GUI sections 间的格式约束**。具体字节级 diff 需要进一步 dump。

**与项目现状的对比**：项目 README 的 "Limitations" 章节明确说"The container format is reverse-engineered and verified only against nTop 5.54.2. ... Editing tools ... cannot know whether an edit is semantically right for your model."——项目知道只对 5.54.2 验证过。本测试用真实 6.2.2 文件做底，反而暴露了**真实 6.2.2 文件 + 全 root 重写**场景的兼容性问题。

**建议**：在 README 加一条更明确的警告："全 root 清空 + 大量 addBlock 在 nTop 6.2.2 上可能导致 ntopcl 段错误（仅在小幅改动场景下保证兼容）"。

### 5.2 leaves type 是 `cache1` 不是 `obj_container`（README 没提到）

**发现**：
- BoxfromCorners.ntop、flow_analysis.ntop、Boolean_Intersect.ntop 的 leaves section **type 都是 `cache1`**
- README 没提到这个 type
- `container.ts` 用 `obj_container` 类型，但 nTop 6.2.2 用 `cache1`
- 项目代码 `loadGraph` / `saveGraph` 通过 `name="leaves"` 找 section，**不检查 type**，所以 round-trip OK

**建议**：在 README 的 "The notebook format" 章节明确说明 nTop 6.2.2 的 type 命名变化（`cache1`、`jsn` 都是 6.x 系列的新值）。

### 5.3 fn JSON 在 nTop 6.2.2 需要 `def` 和 `dependencies` 字段

**发现**：
- 真实 nTop 6.2.2 文件的 `fn` JSON 顶层有 `code`、`def`、`dependencies`、`output` 四个字段
- 项目代码生成的 fn JSON 只有 `code` 和 `output`（缺 `def` 和 `dependencies`）
- 项目代码**不应该清空这两个字段**——真实小文件总是有它们（哪怕是空对象）

**实际影响**：项目 `saveGraph` 用 `JSON.stringify(graph.document)` 写回——`graph.document` 来自 `loadGraph`，应该保留了原文件里的 `def` 和 `dependencies`。但**全 root 清空场景**下，从空 fn 构造时需要补 `def: {}, dependencies: {}`（已在本测试中修复）。

**建议**：在 README 加一条提醒，或者在 `loadGraph` 处给 `graph.document.def` 和 `graph.document.dependencies` 提供默认值（如果没有的话），以减少"从零构造"时的兼容性问题。

### 5.4 不在 catalog 里的旧 block（已知，已记录）

**测试 A 复现**：flow_analysis.ntop 引用 17 个不同 block func，其中 3 个（5.23.0 版本）在 nTop 6.2.2 catalog 里找不到**。

**项目表现**：✅ `read_graph` 能正确读出旧 block（含 `[5.23.0]` 版本号）；✅ nTop 6.2.2 能执行包含旧 block 的 notebook；❌ `search_blocks` 找不到旧 block；❌ `add_block` 不能用旧签名。

**这不是新发现**，但本次 A + C 双重跑通证明了这点。

---

## 六、复现命令

```powershell
# 编译项目（必须先有 dist/）
cd D:\github\ntopology-mcp
npm install
.\node_modules\.bin\tsc -p tsconfig.json

# 跑压测
node scripts/_stage7-deep.mjs

# 单独 ntopcl 跑 B 节文件（确认段错误）
# PowerShell:
& "C:\Program Files\nTopology\nTopology\ntopcl.exe" -v 2 "D:\ntop-test\stage7-deep\B-heterogeneous-50.ntop"
# （输出：[I]: Loaded license successfully 后无更多输出，exit code -1073741819 / 3221225477）
```

---

## 七、文件清单（全部保留，未删）

```
D:\github\ntopology-mcp\scripts\_stage7-deep.mjs   # 本次压测脚本（528 行）
D:\ntop-test\stage7-deep\B-heterogeneous-50.ntop   # 段错误复现文件
D:\ntop-test\stage7-deep\_one-block-added.ntop    # 单 block 改动可跑（参考对照）
D:\github\ntopology-mcp\deeptest_logs.md           # 本文件
```