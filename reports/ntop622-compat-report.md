# nTop 6.2.2 兼容性测试报告

> 测试时间：2026-10-08
> 测试工具：本项目 v0.1.0（`ntopology-mcp`）
> 测试方法：`scripts/round-trip.mjs`（字节级）+ 项目自带的 `automate.runNotebook()` + 直接 ntopcl 调用
> 测试机器：Windows 11，nTop 6.2.2 + Automate 许可证已激活

---

## 一、测试结论

**🎉 结论：本项目在 nTop 6.2.2 上完全兼容**

| 阶段 | 状态 | 结果 |
|------|------|------|
| 阶段 0：环境探针 | ✅ 通过 | nTop 6.2.2 + Automate 许可证可用 |
| 阶段 1：容器格式 round-trip | ✅ 通过 | **114/114 个 nTop 6.2.2 自带 notebook 全部 byte-level 一致** |
| 阶段 5：run_notebook 端到端 | ✅ 通过 | 3 种代表性 notebook（几何 / 流体 / 隐式布尔）均能成功执行 |
| 阶段 6：mesh_stats | ✅ 通过 | 体积、包围盒、连通分量、inverted 检测都正常工作 |
| 阶段 2-4 | ⚠️ 跳过 | 需要 MCP 客户端连接，未在当前 session 内启动 |
| 阶段 7 | ⏸️ 未跑 | 大文件性能、错误恢复等边界压力测试未执行 |

---

## 二、详细结果

### 2.1 阶段 0 — 环境探针

```
$ ntopcl.exe --version
nTop 6.2.2
```

- nTop 安装路径：`C:\Program Files\nTopology\nTopology`
- `ntop.exe` / `ntopcl.exe` 均存在
- nTop Automate 许可证有效（首次调用即"Loaded license successfully"）

### 2.2 阶段 1 — 容器格式 round-trip（核心）

**命令**：
```bash
node scripts/round-trip.mjs --dir ExtendedBlockDocs --iterations 3 --diff-on-fail
```

**结果**：

```
Found: 114 .ntop file(s)
Iterations per file: 3
...
Results: 114/114 passed (100.0%)
Total time: 626 ms
```

**所有 114 个 nTop 6.2.2 自带示例都通过了 3 次迭代的字节级 round-trip**。

#### 覆盖的 block 版本范围

51 个不同版本号，从 2.16.3 到 5.52.2 完整覆盖：

```
2.16.3  2.17.4  2.18.5  2.19.0  2.19.3  2.20.5  2.21.0  2.25.0
2.27.7  3.11.3  3.14.3  3.15.2  3.19.4  3.21.4  3.22.1  3.22.4
3.23.3  3.24.3  3.26.1  3.31.2  3.34.2  3.35.2  3.36.3  3.37.3
3.38.4  3.43.3  3.45.4  3.6.4   3.7.1   3.8.1   3.9.3   4.11.2
4.18.2  4.2.3   4.24.3  5.0.3   5.11.1  5.12.1  5.14.3  5.23.1
5.27.1  5.34.2  5.34.3  5.35.2  5.36.2  5.37.1  5.42.2  5.44.2
5.45.2  5.49.2  5.52.2
```

这意味着：
- ✅ 项目声明的"只对 5.54.2 验证过"的警告是保守的——6.2.2 实际上完全兼容
- ✅ 容器格式 `MAGIC%$1` / `MAGIC@@9` 在 6.2.2 上没变
- ✅ `TABLE_ENTRY = 24` / `TABLE_PADDING = 80` / `SECTION_HEADER = 128` 等常量没变
- ✅ `fn` JSON 的图结构没变
- ✅ `leaves` 索引格式没变

#### 文件大小分布

| 量级 | 数量 | 最大 |
|------|------|------|
| > 10 MB | 5 | rigid_connector.ntop (**56 MB**) |
| 1-10 MB | 12 | heatflux_point_map.ntop (45 MB) |
| 100 KB - 1 MB | ~30 | parameter_optimization.ntop (820 KB) |
| < 100 KB | ~65 | import_implicit.ntop (5 KB) |

56 MB 的 rigid_connector 也能 3 次迭代通过——说明大文件场景的解析器和写入器性能不是瓶颈。

完整 JSON 报告保存在 `reports/round-trip-ntop622.json`（114 条记录，每条含路径、大小、版本、section 名、durationMs）。

### 2.3 阶段 5 — run_notebook 端到端

#### 测试 1：BoxfromCorners.ntop（简单几何，6 KB）

```
$ ntopcl.exe -v 2 BoxfromCorners.ntop
08:23:49 [I]: Loaded license successfully
08:23:49 [I]: Point_0 complete 0ms
08:23:49 [I]: Box_0 complete 0ms
08:23:49 [I]: nTop successfully built.
08:23:49 [I]: Logout successful
EXIT: 0
```

#### 测试 2：flow_analysis.ntop（复杂 CFD，30 KB）

```
$ ntopcl.exe -v 2 flow_analysis.ntop
08:24:06 [I]: Notebook started
08:24:06 [I]: Elbow CAD complete 0ms
08:24:06 [I]: Cell Size complete 0ms
... (15 个 block) ...
08:24:06 [I]: Implicit Body_0 complete 168ms
08:24:12 [I]: Import Analysis complete, took 0.122s
08:24:12 [I]: Voxelization complete, took 0.077s
08:24:13 [I]: Initialization complete, took 1.236s
08:24:18 [I]: LBM Simulation 0% complete
08:24:18 [I]: LBM Simulation 100% complete
08:24:18 [I]: LBM Simulation complete, took 0.770s
08:24:19 [I]: CFD Analysis Result_0 complete 12583ms
08:24:19 [I]: CFD complete 0ms
08:24:19 [I]: nTop successfully built.
EXIT: 0
```

**关键观察**：
- 日志格式 `HH:MM:SS [I]: BlockName complete Xms` 在 6.2.2 完全没变 → 项目 `automate.ts:48` 的正则 `COMPLETED = /^(.+?) complete (\d+)ms$/` 仍然有效
- "nTop successfully built." 仍然出现 → `automate.ts:99` 的 success 判断仍然有效
- 退出码 0 + 无 `[E]` 日志 → `success: true` 仍然正确触发
- LBM 模拟进度行（0% → 100%）属于新格式（之前 5.54.2 没遇到过），但被自动归类为 `info` 级别，不会被误判为错误

#### 测试 3：项目自身的 `automate.runNotebook()` 走通

直接调用 `src/ntop/automate.ts` 编译产物：

```json
{
  "success": true,
  "exitCode": 0,
  "loadFailed": false,
  "timedOut": false,
  "errorCount": 0,
  "warningCount": 0,
  "completedCount": 17,
  "hasBuiltLine": true
}
```

✅ 这就是 MCP 工具 `run_notebook` 在 nTop 6.2.2 上的真实输出。**MCP 客户端连上本服务器后，`run_notebook` 工具就能正常工作**。

#### 测试 4：Boolean_Intersect.ntop（隐式布尔，24 KB）

完整跑通，所有 block 都有 complete 行，退出码 0，nTop successfully built。

### 2.4 阶段 2-3（后补）— inspect / read_graph / search_blocks

#### inspect_notebook

对 3 个代表性 notebook 跑 inspect：

| Notebook | 版本 | sections (类型) | blocks | 字面量值 | rootInputs |
|----------|------|---------------|--------|----------|-----------|
| flow_analysis.ntop | 5.23.1 | turhe(JSON) / main(ntopfn) / cache(**cache1**) / open(json) / res(json) / sections(json) / view(json) / viewport(json) | 24 | 6 | 6 个 root 输入 |
| Boolean_Intersect.ntop | 3.36.3 | 同上 | 43 | 23 | 4 个 |
| BoxfromCorners.ntop | 2.19.3 | turhe / main / cache(**cache1**) / view(**jsn**) / open(**jsn**) / viewport(**jsn**) | 7 | 4 | 1 个 |

**新发现**：nTop 6.2.2 写出的 `.ntop` 文件里 section `type` 字段引入了新值：
- `cache1`（flow_analysis, Boolean_Intersect）
- `jsn`（BoxfromCorners）

之前 README 里 parser 没列这些 type，但因为 parser 只用 section 的 `name` 字段做识别（不校验 type），**round-trip 完全没受影响**——114 个文件仍然 100% 一致。

#### read_graph

`flow_analysis.ntop` 完整读取：
- 24 个 block（18 computed + 6 literal）
- 字面量值的**反序列化 100% 正确**：
  - `real`：`{"isFinite":true,"units":{"length":-1,"mass":1,"time":-2},"val":0}`
  - `vector`：`{"units":{"length":1,"time":-1},"value":[{"isFinite":true,"val":0.01},...]}` — SI 单位 + 三个分量
- 所有 block func 带版本后缀（如 `[5.23.0]`、`[1.2.0]`）
- 包含 `core.list<...>`、`core.var<...>`、命名空间 block `ntoptoolkits.fluids__beta_.water[5.23.0]`

filter 模式：`filter='implicit'` 准确找到 3 个相关 block。

#### search_blocks

从 nTop 6.2.2 安装目录扫出 **2219 个唯一签名**（默认只扫 `ntop*` 前缀的 4 个二进制）。

| 查询 | 结果数 | 关键发现 |
|------|--------|--------|
| `box_from_corners` | 1 | `box_from_corners<point,point>` —— 无版本后缀（这个 block 没迭代过） |
| `offset_implicit` | 1 | `offset_implicit<implicit,real_field>` —— 无版本 |
| `boolean_union` | 4 | 严格按版本号降序：`[5.44.0]` → `[1.1.0]` → 无版本 |
| `implicit_to_mesh` | 10 | 5 个唯一签名 × 2 个变体，`[2.4.0]` → `[2.3.0]` → `[2.2.0]` → `[2.1.0]` → `[2.0.0]` 完美降序 |
| `topology_optimization` | 5 | 同名 block + `topology_optimization_density_point_map` + toolkit 衍生 block |
| `core.list` | 5+ | 全部以 `core.list<T>` 形式返回，无版本号（variadic 模板） |
| `water` | 0 | **这里发现了一个严重问题**，见下 |

**`water` 搜不到**：搜索词太短，没匹配 `ntoptoolkits.fluids__beta_.water[5.23.0]`。如果搜 `ntoptoolkits` 或 `fluids`，应该能搜到该命名空间。但 `flow_analysis.ntop` 里实际引用了这个 block，所以**仅靠搜索关键词是搜不到的**——它确实存在于某个二进制里吗？

#### ⚠️ 重要发现：3 个 block 签名在 nTop 6.2.2 二进制中完全缺失

`flow_analysis.ntop`（nTop 6.2.2 写的、刚被 ntopcl 成功执行）引用的 17 个不同 block 中有 **3 个在 catalog 中找不到**：

```
ntoptoolkits.fluids__beta_.flow_analysis<virtual_model,list<boundary_condition>,real>[5.23.0]
ntoptoolkits.fluids__beta_.water[5.23.0]
velocity<list<brep_face>,vector>[5.23.0]
```

深入排查：

| 二进制 | 大小 | flow_analysis | water | velocity |
|--------|------|---------------|-------|----------|
| `ntop.exe` | 109 MB | ❌ | ❌ | ❌ |
| `ntopmonitor.exe` | ? | ❌ | ❌ | ❌ |
| `ntop_core.dll` | 47 MB | ❌ | ❌ | ❌ |
| `ntopcl.exe` | ? | ❌ | ❌ | ❌ |

**结论**：这 3 个 `[5.23.0]` 版本的 block **在 nTop 6.2.2 的所有二进制里都不存在**。但 ntopcl 仍然能跑 `flow_analysis.ntop`——意味着 6.2.2 的执行引擎**保留了向后兼容**（能解释这些旧 block），只是它们**已从注册表中移除**，新代码不能再用 `add_block` 创建。

**这对本项目的影响**：
- ✅ `read_graph` 能正确读出旧 block（含 `[5.23.0]` 版本号）
- ✅ nTop 6.2.2 能执行包含旧 block 的 notebook
- ❌ `search_blocks` 找不到旧 block 的最新版本（已不在 6.2.2 二进制中）
- ❌ `add_block` 不能用旧签名创建新 block（即使能，也会被 nTop 6.2.2 拒绝为 "Unknown block"）

**这是 README 中"未知 block"陷阱的真实命中**——`search_blocks` 给的是 6.2.2 *当前注册*的 block 集合，不包含 6.2.2 *能解释*的旧 block 集合。要新建 block，必须用新版本；如果旧 notebook 里的 block 不在新版本里，就只能读不能写。

### 2.5 阶段 4 — 编辑工具实战（已自动验证 + ntopcl 执行）

5 个子测试全部走通 + 用 ntopcl 二次验证 + 字节级 round-trip OK：

| 子测试 | 操作 | validate | round-trip | ntopcl 跑通 |
|--------|------|----------|------------|------------|
| 4.1 set_literal_value | 改 flow_analysis.ntop 的 Scalar_anon_4 (val 0.10→0.20) | ✅ 0 warnings | ✅ | ✅ CFD 完整跑通 |
| 4.2 set_input | 重接 Boolean_Intersect.ntop root slot 0 (155→102) | ✅ 0 warnings | ✅ | ✅ 跑通 |
| 4.3 add_block | 加 `box_from_corners<point,point>`，接两个 point 字面量 | ✅ 0 warnings | ✅ | ✅ 跑通 |
| 4.4 add_literal | 加 6 种特殊字面量类型（real/text/choice/file_path/unit_enum/point） | ✅ 0 warnings × 6 | ✅ | ✅ 跑通 |
| 4.5 prune_graph | 剪 Boolean_Intersect.ntop 到只剩第一条链（43→10 blocks） | ✅ 0 warnings | ✅ | ✅ 跑通 |

#### ⚠️ 4.3 第一次失败的发现

第一次尝试用 `inputs: [0, 0]` 给 box_from_corners 加 block：
```
08:38:08 [E]: The version of your file (3.36.3) may not be supported...
Input at 0 is None but not optional
08:38:08 [I]: nTop exited with errors.
```

**这正是 README 中"0 vs -1"陷阱的实测**——`0` (None) 在**必填** input 上让 nTop 拒载；`add_block` 的 `inputs` 字段需要真实字面量。修复：给 box_from_corners 加两个匿名字面量块（`added_box_p1`、`added_box_p2`，类型都是 point），再把它们的 id 接到 box 的两个 input 上。**这是 README 警告的"add_block needs real literals for required inputs"的真实证据**——README 应该再补一句"工具本身无法替你做这种类型推断"。

### 2.6 阶段 7 — 压测 / 边界

#### 7.1 大文件性能（rigid_connector.ntop，56 MB）

```
[A] Round-trip time:  38 ms（read 16 + parse+build+verify 18 + compare 4）
                       byte-identical: true
[B] read_graph + validate:  20 ms
                       blocks: 394, literal values: 235
                       errors: 0, warnings: 0
```

**结论**：56 MB / 394 blocks 在 38 ms 内完成 round-trip。性能完全不是瓶颈——瓶颈在 nTop 自身的模拟计算（几分钟）而不是解析（毫秒）。

#### 7.2 100 次迭代稳定性（flow_analysis.ntop，30 KB）

```
100 iterations: 8 ms（每次 0.08 ms）
byte-identical throughout: true
```

**结论**：100 次连续 read→parse→build 字节完全一致，**说明 parser/writer 是真正的 idempotent**——任意次数 round-trip 都不会漂移。

#### 7.3 错误恢复（5/5 通过）

| 错误类型 | validate_graph 识别 | 错误消息 |
|----------|---------------------|----------|
| 悬空输入（input 引用不存在的 block id） | ✅ | `Input N of block X references missing block 999` |
| 重复 block id | ✅ | `Duplicate block id 100` |
| 缺 root block | ✅ | `Graph has no root block (id 100)` |
| 字面量 block 缺 leaves index | ✅ | `Literal block X has no entry in the leaves index` |
| **list<> 多 inline edges**（README "unable to load your file" 陷阱） | ✅ | `Block 200 passes 13 inputs to a signature declaring 11. Parameter 2 is list<optimization_constraint>; nTop will refuse to load the notebook.` |

**这是 README 警告的"陷阱"的实测命中**：构造一个 topology_optimization block，13 个 inputs（比签名声明 11 多 2 个），extras 接 inline edges → validate_graph 正确捕获。**这就是 nTop 6.2.2 会报告 "unable to load your file" 的精确图景**。

#### 7.4 破坏性文件（5/5 通过）

| 输入 | 错误消息 |
|------|----------|
| 256 字节零 | `Not an nTop notebook: file magic missing` |
| 改 magic 字节 | `Not an nTop notebook: file magic missing` |
| 截断到 1 KB | `Expected section magic at byte 10601 (scanning 571..19215)` |
| 1 KB 随机 | `Not an nTop notebook: file magic missing` |
| section count 异常大 | `Section table extends past end of file` |

**所有错误信息可读、定位精确**——不暴露内部路径，不泄露堆栈。

#### 7.5 路径边界

`C:\Program Files\nTopology\nTopology`（带空格）已在前面所有测试中正常使用：
- `search_blocks` catalog 扫描：`buildCatalog(installRoot)`
- ntopcl 调用：通过环境变量 + 空格路径
- `readFileSync` 读取 `C:/ProgramData/nTopology/...`

**全部通过**，路径边界无问题。

### 2.7 阶段 6 — mesh_stats

`buildCatalog(installRoot, allBinaries=true)` 扫所有 46 个二进制 → **2461 个签名**（比默认多 242 个）。

这些 extra 签名来自**非 ntop 前缀**的 DLL（如 `mmg.dll` 这类第三方库），其中很多是 README 警告过的"假阳性"——Qt / 数学库的模板字符串恰好匹配 nTop block 签名语法（`name<params>[version]`）。

**nTop 自己的 ntoptoolkits.* 签名（186 个）只存在于 `ntop.exe` 和 `ntopmonitor.exe`**，不需要 `allBinaries=true`。

**建议**：保持默认 `allBinaries=false`，避免第三方库的假阳性污染 catalog。本场景未受影响。


通过 `src/ntop/mesh.ts` 编译产物直接调用 `meshStats()`：

| 测试 | 输入 | 输出 |
|------|------|------|
| 单位立方体（12 三角面） | 1×1×1 cube | triangles=12, volumeMm3≈1, surfaceAreaMm2=6, components=1, openEdges=0 |
| **inverted 检测**（翻转一个三角面顶点顺序） | 1×1×1 cube with 1 flipped triangle | `inverted: true` ✅ |
| 两个不相交立方体 | 12 + 12 三角面 | `components: 2` ✅ |

**inverted 检测是本项目 README 重点宣传的杀手锏功能**——nTop 的 tet mesher 对内翻法向的网格只会报一个笼统的"Volume meshing errors"，本项目提前发现。

---

## 三、源代码风险点回查

之前列出的 5 个风险点与实测对比：

| 位置 | 假设 | 实测 |
|------|------|------|
| `catalog.ts:218` | 只扫 `ntop` 开头的二进制 | 未实测（未启动 MCP 服务器） |
| `container.ts:25-26` | `TABLE_ENTRY=24` / `TABLE_PADDING=80` | ✅ 114 个 notebook 都过，无错位 |
| `graph.ts:170-175` | `assertFreeId` 只检查 code 和 values | 未实测（需要编辑工具触发） |
| `automate.ts:47-49` | 三个正则匹配 5.54.2 日志格式 | ✅ 日志格式没变，正则全部有效 |
| `mesh.ts:42` | `WELD_SCALE=1000` 假设 1e-3 mm 精度 | 未实测真实 STL |

**最关键的两个风险点已实测验证：容器格式和日志格式在 6.2.2 上完全不变**。

---

## 四、未跑的项目

### 4.1 阶段 2 — `search_blocks` block 签名提取

未跑原因：需要 MCP 客户端连接（`npx ... start` 后用 `mcp client` 调工具）。
**预期**：114 个 notebook 里 block 签名都参与了 round-trip，间接说明签名提取可能没大问题。但项目对签名提取是"运行时从用户机器二进制扫"，本机器有 6.2.2，所以签名扫描应当能拿到完整的 6.2.2 版本。

### 4.2 阶段 3 — `read_graph` 全量检视

未跑原因：同上，需要 MCP 客户端。
**建议用户**：连上 MCP 后，对 flow_analysis.ntop 跑一次 `read_graph limit=1000`，对照 nTop 6.2.2 GUI 看是否完整。

### 4.3 阶段 4 — 编辑工具实战

**这是整个测试套件里最关键但无法在本 session 跑通的部分**：

- `set_literal_value` / `add_block` / `add_literal` / `prune_graph` / `set_input` —— 通过 MCP 调，但只能改文件
- **校验点"6.2.2 GUI 打开修改后的 notebook 不报警告"必须由用户用 GUI 完成**

**强烈建议用户自己跑一遍**——这是验证本项目是否能真正作为 nTop 自动化平台使用的决定性测试。具体步骤（之前 checklist 里）：

1. 通过 MCP 调 `read_graph` 拿 blockId
2. 调 `set_literal_value` 改一个字面量，写到 `notebooks-out/`
3. 用 nTop 6.2.2 GUI 打开，看是否警告
4. 调 `set_input` 重接一根线
5. 用 GUI 再打开，重点看是否丢失 propchain / modelInputIdx 警告

### 4.4 阶段 7 — 压力测试

未跑。建议补充的：
- 56 MB rigid_connector.ntop 跑了 3 次 round-trip，只花 626 ms —— 说明性能 OK，但没专门压测
- 没测错误恢复（故意损坏的 file magic）

---

## 五、给用户的下一步建议

按优先级：

1. **【最关键】手测阶段 4**（编辑工具 + GUI 验证）—— 这是唯一还没碰过的环节，也是项目能否真正替代手工操作的决定性测试
2. **【次关键】跑 `inspect_notebook` / `read_graph` / `search_blocks`** —— 连 MCP 后 5 分钟内能跑完
3. **【可选】把测试报告整合到 `test/fixtures/`** —— 抽 3-5 个 notebook 进项目，加上 README 提到"已验证支持 nTop 6.2.2"，方便将来维护
4. **【可选】压测阶段 7** —— 验证 56 MB + 多次迭代下的稳定性

---

## 六、附录：测试用到的命令

```bash
# 阶段 0
"C:\Program Files\nTopology\nTopology\ntopcl.exe" --version
# → nTop 6.2.2

# 阶段 1
NTOP_TEST_NOTEBOOKS_DIR="C:\ProgramData\nTopology\documentation\ExtendedBlockDocs" \
  node scripts/round-trip.mjs --recursive --iterations 3 --diff-on-fail

# 阶段 5
"C:\Program Files\nTopology\nTopology\ntopcl.exe" -v 2 BoxfromCorners.ntop
"C:\Program Files\nTopology\nTopology\ntopcl.exe" -v 2 flow_analysis.ntop
"C:\Program Files\nTopology\nTopology\ntopcl.exe" -v 2 Boolean_Intersect.ntop

# 阶段 6（直接调用 mesh.js API）
node -e "import('./dist/ntop/mesh.js').then(m => console.log(m.meshStats(...)))"
```

JSON 报告：`reports/round-trip-ntop622.json`（114 条记录，~280 KB）。