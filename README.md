# xiaomi-eas-import-adapter（小爱伴侣教务导入适配）

将**杭州电子科技大学本科教务系统（EAS，正方教务 newjw.hdu.edu.cn）**的课表数据，
适配导入「小爱课程表」（小爱伴侣）开发者扩展的 Provider / Parser / Timer 代码。

> 仓库：`https://github.com/Wujilun06/xiaomi-eas-import-adapter`
> 本项目**不含任何密钥 / 登录态文件**：教务登录态由「小爱课程表」的教务 WebView 在运行时获取，
> `provider.js` / `parser.js` 仅做课表解析，代码中无硬编码凭据。

---

## 1. 简介

- **用途**：让使用小爱课程表的杭电同学，能一键把正方教务的个人课表导入到小爱课程表 App。
- **形态**：三个 JavaScript 文件（`provider.js` / `parser.js` / `timer.js`）+ 一个 `manifest.json`
  描述文件，按「小爱课程表开发者工具」规范编写，无构建步骤、无后端。
- **运行环境**：
  - `provider.js` 在**已登录的教务 WebView** 中执行，负责把含课表的页面内容提取成字符串。
  - `parser.js` 在**小爱课程表服务器端**执行，负责把字符串解析成标准课程数组。
  - `timer.js` 在教务 WebView 中执行，返回学期总周数等信息。

---

## 2. 原理

### 2.1 用到的编程语言与软件程序

| 类别 | 内容 |
|------|------|
| 编程语言 | **JavaScript（ES，无框架、无构建工具）** |
| 运行平台 | **小爱课程表开发者工具**（Chrome/Edge 浏览器扩展，加载解压后的扩展即可开发） |
| 运行环境 | 教务系统 WebView（Provider/Timer）/ 小爱课程表服务器（Parser） |
| 平台 API | `loadTool('AIScheduleTools')`、`AISchedulePrompt`、`AIScheduleAlert`（平台注入，非标准 DOM API） |
| 适配目标 | 杭电正方教务 `newjw.hdu.edu.cn`（xqm：上学期=3 / 下学期=12 / 短学期=16） |

### 2.2 数据流与工作原理

```
教务 WebView 中：scheduleHtmlProvider()
   1) AISchedulePrompt 让用户输入「学年」与「学期(1/2/3)」
   2) 用 credentials:'include' 相对路径 POST 个人课表接口
      （gnmkdm 从当前页 URL 动态取，杭电个人课表页是 N253508，非通用 N2151）
   3) 命中 JSON(kbList) → 返回 JSON 字符串；否则 fallback 整页 outerHTML（服务端渲染，属预期路径）
        │
        ▼ 字符串上传到服务器
服务器中：scheduleHtmlParser()
   1) 优先解析 JSON(kbList) 分支
   2) 否则解析「列表视图」#kblist_table（结构最清晰、最稳）
   3) 再否则解析「表格视图」#kbgrid_table_0（脆弱，兜底）
    → 返回 courseInfos 数组（name/position/teacher/weeks/day/sections）
        │
        ▼
教务 WebView 中：scheduleHtmlTimer()
   返回课程时间、学期总周数等
```

- **为何能免登录态硬编码**：Provider 用相对路径 + `credentials: 'include'` 发起 `fetch`，
  沿用当前教务 WebView 已有的登录会话；`provider.js` / `parser.js` 本身不存储任何账号密码。
- **为何有 HTML fallback**：杭电个人课表页是服务端直接渲染，`kbList` 接口不一定稳定返回 JSON，
  此时整页 `outerHTML` 即含完整课表，Parser 的列表视图分支可正确解析——这是**预期路径，无需告警**。

---

## 3. 具体实现方式

### 3.1 目录结构

```
xiaomi-eas-import-adapter/
├── README.md              # 本文件
├── manifest.json          # 扩展描述（id/version/developer/schoolIds/origins/capabilities/文件哈希）
├── provider.js            # 在教务 WebView 执行：取学年/学期 → 拉课表 → 返回字符串
├── parser.js              # 在服务器执行：解析字符串 → courseInfos 数组
├── timer.js               # 在教务 WebView 执行：返回学期周数等
└── .gitignore             # 预置忽略 private_config.json（本项目无需，仅遵循统一约定）
```

### 3.2 关键实现点

- **`provider.js` 的 `xqm` 映射**：学期选择 `1/2/3` → 正方教务 `3 / 12 / 16`。
- **`provider.js` 的 `gnmkdm` 动态获取**：`new URLSearchParams(location.search).get('gnmkdm') || 'N2151'`，
  兼容杭电个人课表页 `N253508`。
- **`parser.js` 三分支优先级**：JSON(kbList) → 列表视图(#kblist_table) → 表格视图(#kbgrid_table_0)。
  列表视图用 `#kblist_table` 下按 `<tbody id="xq_N">` 分星期，每行 `festival` 节次 + `timetable_con`
  纯文本（字段固定文案「周数：/校区:/上课地点：/教师 ：/教学班：」）。
- **节次/周次解析**：`parseSections` 支持 `3-5`/`1-2`/`10-11`/`3`；`parseWeeks` 支持
  `1-17周`/`1-6周,9-17周`/`1-16周(单)`/`1-16周(双)`（单双周过滤）。

### 3.3 在小爱课程表开发者工具中的使用

1. 浏览器加载「小爱课程表开发者工具」扩展（Edge/Chrome 开发者模式 → 加载解压缩的文件夹）。
2. 登录小米账号 → 新建项目（学校选「杭州电子科技大学」/ 教务系统选「本科教务(正方)」）→ 拿到平台分配的 `schoolId`。
3. 把本仓库 `provider.js` / `parser.js` / `timer.js` 内容依次粘贴进对应版本；填好 `manifest.json` 的
   `developer` 与 `schoolIds`（见第 4 节占位符）。
4. 本地测试 / E2E 测试 → 提审 → 审核通过后用户可搜到并导入。

---

## 4. 可能用到的隐私权限和私人内容

本项目**不需要、也不包含**任何隐私文件：

- **无 `private_config.json`**：运行时不读取任何密钥 / 登录态文件（统一的「单一隐私文件」约定之例外）。
- **教务账号密码不落地**：登录态由「小爱课程表」的教务 WebView 在用户操作时获取，
  `provider.js` 仅用 `credentials: 'include'` 复用该会话，代码中**无硬编码账号密码**。
- **`manifest.json` 的占位符**：`developer`（你的小爱开发者标识，如 QQ 号）、`schoolIds`
  （平台创建学校项目后由平台分配）、`sources.repository`（你的源码仓库地址）均为公开占位符，需替换，
  但**不含任何秘密**。
- **请勿提交个人课表 / 学号**：调试导出的课表含个人数据，请勿把含个人信息的文件提交到仓库。

> 若未来为别的学校/系统做适配并需要密钥，请仍遵循统一约定：集中到 `private_config.json` 并 `.gitignore` 忽略。

---

## 5. 项目开发 / 部署过程中遇到的问题及解决方案（真实记录）

以下为适配杭电正方教务时**实际踩过的坑**，后续维护直接对照排查。

1. **杭电个人课表页 `gnmkdm` 不是通用值**
   - 现象：通用正方教务个人课表页是 `N2151`，但杭电是 `N253508`，硬编码会取错接口。
   - 解决：`provider.js` 从当前页 URL 的 `gnmkdm` 参数动态读取，`|| 'N2151'` 兜底。
2. **课表接口有时返回 HTML 而非 JSON**
   - 现象：部分情况下 `xskbcx_cxXsgrkb` 返回的是整页 HTML 而不是 `kbList` JSON。
   - 解决：Provider 先尝试 `JSON.parse`，失败则 `return document.documentElement.outerHTML`；
    Parser 优先 JSON 分支，失败走列表视图 HTML 解析。**整页 HTML 是预期路径，不告警。**
3. **正方教务 `xqm` 取值非直觉**
   - 现象：上学期不是 `1` 而是 `3`，下学期是 `12`，短学期是 `16`。
   - 解决：在 Provider 用 `{ '1':'3', '2':'12', '3':'16' }` 映射用户选择的学期。
4. **用户不在课表页就点「开始导入」**
   - 现象：Provider 拿不到必要页面内容，原逻辑直接报错。
   - 解决：在异常/缺内容时 `AIScheduleAlert` 提示，并返回平台约定的 `'do not continue'` 终止，
   等用户回到正确页面重新导入。
5. **平台要求「代码最后一行不要加分号」**
   - 现象：小爱课程表会把代码挂到 `window` 上，行尾分号会导致注入报错。
   - 解决：三个 `.js` 文件末尾均不加 `;`，保持平台规范。
6. **`manifest.json` 的 `schoolId` 是占位符**
   - 现象：仓库里的 `schoolIds` 是 `<请替换...>` 占位符，直接打包会无效。
   - 解决：必须在开发者工具创建学校项目、由平台分配真实 `schoolId` 后回填；
   `files` 里的哈希由平台在提交时计算，本地无需手动维护。
7. **自行抽离的函数必须放在平台提供的函数块内**
   - 现象：真机测试中，写在函数块外的辅助函数可能不生效。
   - 解决：所有自定义函数（`parseSections` / `parseWeeks` / `stripHtml` 等）都定义在
   `scheduleHtmlParser` 函数体**内部**或随其一并加载，不脱离平台函数作用域。

---

## 6. 致谢

- **小爱课程表（小爱伴侣）开发者平台**：提供教务导入的 Provider / Parser / Timer 框架与开发者工具。
  - 开发者工具与文档：`https://open-schedule-prod.ai.xiaomi.com/`
  - 帮助文档：`https://open-schedule-prod.ai.xiaomi.com/docs/#/help/`
  - 课程表开发者资源库：`https://open-schedule-prod.ai.xiaomi.com/docs/#/assets/`
  - 更新日志：`https://open-schedule-prod.ai.xiaomi.com/docs/#/release/`
- **杭电正方教务系统（newjw.hdu.edu.cn）**：本适配的目标教务系统。
- 感谢社区已有的各类正方/强智教务适配示例（如各高校在小爱课程表资源库的公开适配），
  为课表 HTML 结构解析提供了思路参考。

---

## 附：后续开发与维护要点

- **换学校/换教务系统**：改 `manifest.json` 的 `origins` / `systemTypes` / `schoolIds`；按目标教务的
  页面结构重写 `provider.js` 的取数逻辑与 `parser.js` 的解析分支（列表视图优先、表格视图兜底）。
- **改课表字段映射**：`parser.js` 的 `WEEK_MAP`、节次/周次解析函数、`name/teacher/position` 正则
  是与目标教务强绑定的，调整时优先改这三处。
- **本地调试**：用开发者工具的「本地测试」把代码注入当前打开的网页；真机导入后在小爱课程表
  「个人设置 → 最下方开关」打开 VConsole 查看本次导入详情与错误。
- **提审注意**：调试用的 VConsole 在正式审核前必须移除；项目介绍/强提示/审核提示按平台要求填写。
- **平台规范红线**：代码最后一行不加 `;`，自定义函数放在平台函数块内。
