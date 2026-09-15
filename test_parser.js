// 解析器验证脚本（Node 运行，无需浏览器）
// 用法：node test_parser.js
// 优先读取真实课表 HTML，否则用内置样本；同时验证 JSON 分支未损坏。

const fs = require('fs')
const vm = require('vm')
const path = require('path')

// 载入 parser.js（其顶层 function 声明在 runInThisContext 下成为全局）
const parserCode = fs.readFileSync(path.join(__dirname, 'parser.js'), 'utf8')
vm.runInThisContext(parserCode)

const WEEK = ['', '一', '二', '三', '四', '五', '六', '日']

function findRealHtml() {
  const candidates = [
    'C:/Users/21654/Downloads/个人课表查询.html',
    path.join(__dirname, '个人课表查询.html'),
    path.join(__dirname, 'sample_schedule.html')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function validate(label, courses) {
  console.log(`\n========== ${label} ==========`)
  console.log('解析课程数：', courses.length)
  let bad = 0
  for (const c of courses) {
    const ok = c.name && c.day >= 1 && c.day <= 7 && c.sections.length && c.weeks.length
    if (!ok) bad++
    console.log(
      `  ${WEEK[c.day]} ${c.sections.join(',')}节 | ${c.name}` +
      ` | 周:${c.weeks[0]}-${c.weeks[c.weeks.length - 1]}(${c.weeks.length})` +
      ` | ${c.position} | ${c.teacher}` +
      (ok ? '' : '  <-- 字段缺失!')
    )
  }
  console.log(bad === 0 ? `  ✅ 全部字段完整 (${courses.length} 门)` : `  ❌ 有 ${bad} 门字段缺失`)
  return { count: courses.length, bad }
}

// ---------- 1) 真实 HTML ----------
const realPath = findRealHtml()
if (realPath) {
  console.log('读取真实样本：', realPath)
  const html = fs.readFileSync(realPath, 'utf8')
  const r1 = validate('真实课表 HTML（列表视图）', scheduleHtmlParser(html))
  if (r1.bad !== 0 || r1.count !== 15) {
    console.log('  ⚠️ 期望 15 门且全部完整，请检查 parser')
    process.exitCode = 1
  }
} else {
  console.log('未找到真实样本，跳过 HTML 验证')
}

// ---------- 2) JSON 分支（合成 kbList，验证未损坏）----------
const syntheticJson = JSON.stringify({
  kbList: [
    { kcmc: '测试课A', xm: '张老师', cdmc: '教3-301', xqj: 1, jc: '1-2节', zcd: '1-16周(单)' },
    { kcmc: '测试课B', xm: '李老师', cdmc: '教5-202', xqjmc: '星期三', jc: '3-4节', zcd: '1-8周,10-16周' },
    { kcmc: '无周次课', xm: '王', cdmc: 'x', xqj: 5, jc: '1-2节', zcd: '' }
  ]
})
const r2 = validate('合成 kbList JSON（单双周/逗号区间）', scheduleHtmlParser(syntheticJson))
if (r2.count !== 2) {
  console.log('  ⚠️ JSON 分支期望解析出 2 门（无周次应被跳过）')
  process.exitCode = 1
}

console.log('\n完成。')
