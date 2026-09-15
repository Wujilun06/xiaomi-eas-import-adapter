// 杭电本科教务系统（newjw.hdu.edu.cn，正方教务）课表适配器 —— Parser
// 在服务器环境运行，输入为 Provider 返回的字符串，输出 courseInfos 数组
// courseInfos 字段：name(课程名) position(地点) teacher(教师) weeks(周次[]) day(星期1-7) sections(节次[])
//
// 数据来源说明：
//   杭电个人课表页（gnmkdm=N253508）是服务端直接渲染，Provider 会把整页 outerHTML 交给我。
//   页面含两套等价展示：
//     · 列表视图 #kblist_table：按 <tbody id="xq_N"> 分星期，每行 <span class="festival">节次</span>
//       后接 <div class="timetable_con"> 纯文本，字段用固定文案（周数：/校区:/上课地点：/教师 ：/教学班：）。
//     · 表格视图 #kbgrid_table_0：格子 id="day-section"，但节次需用 (X-Y节) 文本推断，较脆弱。
//   因此本 Parser 优先解析「列表视图」，结构最清晰、最稳。
//   若 Provider 成功命中 JSON 接口（kbList），则走 JSON 分支。

function parseSections(jc) {
  // 支持 "3-5" / "1-2" / "10-11" / "3"（列表视图 festival 文本，或 JSON 的 jc 字段）
  if (!jc) return []
  var text = String(jc)
  var out = []
  var parts = text.split(/,|，/)
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/节/g, '').trim()
    var m = p.match(/(\d+)\s*-\s*(\d+)/)
    if (m) {
      var a = parseInt(m[1], 10), b = parseInt(m[2], 10)
      for (var k = a; k <= b; k++) out.push(k)
    } else {
      var s = p.match(/(\d+)/)
      if (s) out.push(parseInt(s[1], 10))
    }
  }
  return out
}

function parseWeeks(zcd) {
  // 支持 "1-17周" / "1-6周,9-17周" / "1周" / "1-16周(单)" / "1-16周(双)"
  if (!zcd) return []
  var text = String(zcd)
  var isOdd = text.indexOf('单') !== -1
  var isEven = text.indexOf('双') !== -1
  var out = []
  var parts = text.split(/,|，/)
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    var m = part.match(/(\d+)\s*-\s*(\d+)/)
    if (m) {
      var a = parseInt(m[1], 10), b = parseInt(m[2], 10)
      for (var k = a; k <= b; k++) {
        if (isOdd && k % 2 === 0) continue
        if (isEven && k % 2 === 1) continue
        out.push(k)
      }
    } else {
      var s = part.match(/(\d+)/)
      if (s) {
        var v = parseInt(s[1], 10)
        if (isOdd && v % 2 === 0) continue
        if (isEven && v % 2 === 1) continue
        out.push(v)
      }
    }
  }
  var seen = {}, uniq = []
  for (var j = 0; j < out.length; j++) {
    if (!seen[out[j]]) { seen[out[j]] = true; uniq.push(out[j]) }
  }
  uniq.sort(function (x, y) { return x - y })
  return uniq
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// 单条列表视图课程的纯文本 -> courseInfo
function parseListCell(txt, day, sectionText) {
  if (!txt) return null
  // 课程名 = “周数：”之前的部分
  var name = txt.split(/\s+周数：/)[0].trim()
  if (!name) return null

  var weeksM = txt.match(/周数：(\S+)/)
  var weeks = weeksM ? parseWeeks(weeksM[1]) : []

  // 位置 = 上课地点（不拼校区，保持简洁）
  var locM = txt.match(/上课地点[：:]([^\s]+)/)
  var position = locM ? locM[1].trim() : ''

  var teachM = txt.match(/教师\s*：(.+?)\s+教学班：/)
  var teacher = teachM ? teachM[1].trim() : ''

  var sections = parseSections(sectionText)
  if (sections.length === 0 || weeks.length === 0) return null

  return { name: name, teacher: teacher, position: position, day: day, sections: sections, weeks: weeks }
}

function parseListHtml(html) {
  var result = []
  // 按星期分组切开：<tbody id="xq_1"> ... <tbody id="xq_2"> ...
  var blocks = html.split(/<tbody id="xq_(\d+)"/)
  for (var bi = 1; bi < blocks.length - 1; bi += 2) {
    var day = parseInt(blocks[bi], 10)
    var content = blocks[bi + 1]
    if (!(day >= 1 && day <= 7)) continue

    // 每条课程：jc_ 单元格里的 festival 节次 + 随后的 timetable_con 纯文本
    var re = /<td id="jc_[^"]*"[^>]*>\s*<span class="festival">([^<]*)<\/span>[\s\S]*?<div class="timetable_con text-left">([\s\S]*?)<\/div>\s*<\/td>/g
    var mm
    while ((mm = re.exec(content)) !== null) {
      var sectionText = mm[1].trim()
      var cellText = stripHtml(mm[2])
      var course = parseListCell(cellText, day, sectionText)
      if (course) result.push(course)
    }
  }
  return result
}

function parseJsonKbList(courseText) {
  // 兜底：若 Provider 命中了 JSON 接口（标准正方 kbList 字段）
  var data = JSON.parse(courseText)
  var kbList = (data && data.kbList) || []
  var WEEK_MAP = {
    '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 7,
    '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 7
  }
  var result = []
  for (var i = 0; i < kbList.length; i++) {
    var c = kbList[i]
    var name = (c.kcmc || c.kcMc || '').toString().trim()
    if (!name) continue
    var teacher = (c.xm || c.jsxm || c.jsmc || '').toString().trim()
    var position = (c.cdmc || c.jasmc || '').toString().trim()
    if (!position && c.jxbmc) position = c.jxbmc.toString().trim()
    var day = parseInt(c.xqj, 10)
    if (isNaN(day) && c.xqjmc) day = WEEK_MAP[c.xqjmc] || 0
    if (!(day >= 1 && day <= 7)) continue
    var sections = parseSections(c.jc)
    var weeks = parseWeeks(c.zcd)
    if (sections.length === 0 || weeks.length === 0) continue
    result.push({ name: name, teacher: teacher, position: position, day: day, sections: sections, weeks: weeks })
  }
  return result
}

function scheduleHtmlParser(courseText) {
  if (!courseText || typeof courseText !== 'string') return []

  // 1) JSON 接口分支
  var trimmed = courseText.trim()
  if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try {
      var fromJson = parseJsonKbList(courseText)
      if (fromJson.length > 0) return fromJson
    } catch (e) { /* 不是合法 JSON，继续走 HTML */ }
  }

  // 2) 列表视图 HTML 分支（主要路径）
  if (courseText.indexOf('kblist_table') !== -1) {
    var fromList = parseListHtml(courseText)
    if (fromList.length > 0) return fromList
  }

  // 3) 表格视图兜底（格子 id="day-section"）
  if (courseText.indexOf('kbgrid_table_0') !== -1) {
    var fromGrid = parseGridHtml(courseText)
    if (fromGrid.length > 0) return fromGrid
  }

  console.log('Parser：未在输入中识别到课表数据（既非 JSON，也未找到 kblist_table / kbgrid_table_0）。请把本次 provider 输出发给开发者核对。')
  return []
}

function parseGridHtml(html) {
  var result = []
  var re = /<td[^>]*id="(\d+)-(\d+)"[^>]*>([\s\S]*?)<\/td>/g
  var mm
  while ((mm = re.exec(html)) !== null) {
    if (mm[3].indexOf('timetable_con') === -1) continue
    var day = parseInt(mm[1], 10)
    var cell = mm[3]
    var txt = stripHtml(cell)
    var nameM = cell.match(/class="title">\s*<font[^>]*>([^<]+)<\/font>/)
    var name = nameM ? nameM[1].trim() : txt.split(/\s+/)[0]
    if (!name) continue
    // 节次文本形如 (3-5节)，周次文本形如 )1-17周 或 )1-6周,9-17周
    var jcM = txt.match(/\(([^)]*节)/)
    var weekM = txt.match(/\)([0-9,\-]+周)/)
    var sections = jcM ? parseSections(jcM[1]) : []
    var weeks = weekM ? parseWeeks(weekM[1]) : []
    var locM = txt.match(/上课地点[：:]\s*(\S+)/) || txt.match(/([第].*?(教研楼|楼|中心|馆|房)\S*)/)
    var position = locM ? locM[1].trim() : ''
    var teachM = txt.match(/([\u4e00-\u9fa5]{2,4})(?=\s*\(20)/)
    var teacher = teachM ? teachM[1].trim() : ''
    if (sections.length === 0 || weeks.length === 0) continue
    result.push({ name: name, teacher: teacher, position: position, day: day, sections: sections, weeks: weeks })
  }
  return result
}
