// 杭电本科教务系统（newjw.hdu.edu.cn，正方教务）课表适配器 —— Provider
// 在已登录的教务 webview 环境中运行，返回课表数据字符串（供 Parser 解析）

async function scheduleHtmlProvider() {
  await loadTool('AIScheduleTools')
  try {
    // 1) 让用户选择学年与学期
    const year = await AISchedulePrompt({
      titleText: '学年',
      tipText: '请输入本学年开始的年份\n例如 2025-2026 学年请输入 2025',
      defaultText: '2025',
      validator: (value) => {
        const v = parseInt(value)
        if (!v || v < 2000 || v > 2100) return '请输入正确的学年（如 2025）'
        return false
      }
    })

    const term = await AISchedulePrompt({
      titleText: '学期',
      tipText: '1=上学期  2=下学期  3=短学期\n请输入对应数字',
      defaultText: '1',
      validator: (value) => {
        if (value === '1' || value === '2' || value === '3') return false
        return '请输入 1 / 2 / 3'
      }
    })

    // 正方教务 xqm 取值：上学期=3，下学期=12，短学期=16
    const xqm = { '1': '3', '2': '12', '3': '16' }[term]

    // 2) 请求个人课表接口（相对路径，沿用当前教务域名的登录态）
    // 先从当前课表页 URL 取 gnmkdm（杭电个人课表页是 N253508，不是通用的 N2151）
    var urlParams = new URLSearchParams(location.search)
    var gnmkdm = urlParams.get('gnmkdm') || 'N2151'

    const res = await fetch('/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + gnmkdm, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      referrer: location.href,
      body: 'xnm=' + year + '&xqm=' + xqm + '&kzlx=ck&xsdm='
    })

    // 若接口正常返回且含 kbList，优先走 JSON 解析
    if (res.ok) {
      const text = await res.text()
      try {
        const ret = JSON.parse(text)
        if (ret && Array.isArray(ret.kbList) && ret.kbList.length > 0) {
          return JSON.stringify({ year: parseInt(year), term: parseInt(term), kbList: ret.kbList })
        }
      } catch (e) {
        // 返回的是 HTML 而非 JSON，继续 fallback
      }
    }

    // Fallback：接口不可用或返回 HTML（杭电个人课表是服务端渲染，outerHTML 即含完整课表），
    // 把整页 HTML 交给 Parser 解析。这是预期路径，无需告警。
    console.log('Provider：未命中课表 JSON 接口，改用页面 HTML 解析（杭电本科课表为服务端渲染，属正常路径）。')
    return document.documentElement.outerHTML
  } catch (error) {
    console.error(error)
    await AIScheduleAlert('读取失败：' + (error && error.message ? error.message : '请确认已登录教务系统') + '，将使用页面 HTML 解析。')
    return document.documentElement.outerHTML
  }
}
