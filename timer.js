// 杭电本科教务系统（正方）课表适配器 —— Timer
// 返回学期总周数、节次时间等配置（杭电统一上下课时间）

var HDU_SECTIONS = [
  { section: 1, startTime: '08:05', endTime: '08:50' },
  { section: 2, startTime: '08:55', endTime: '09:40' },
  { section: 3, startTime: '10:00', endTime: '10:45' },
  { section: 4, startTime: '10:50', endTime: '11:35' },
  { section: 5, startTime: '11:40', endTime: '12:25' },
  { section: 6, startTime: '13:30', endTime: '14:15' },
  { section: 7, startTime: '14:20', endTime: '15:05' },
  { section: 8, startTime: '15:15', endTime: '16:00' },
  { section: 9, startTime: '16:05', endTime: '16:50' },
  { section: 10, startTime: '18:30', endTime: '19:15' },
  { section: 11, startTime: '19:20', endTime: '20:05' },
  { section: 12, startTime: '20:10', endTime: '20:55' }
]

async function scheduleTimer(args) {
  var providerRes = args && args.providerRes
  var parserRes = args && args.parserRes
  var showWeekend = false
  var maxWeek = 0
  var list = parserRes || []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    if (item.day > 5) showWeekend = true
    var weeks = item.weeks || []
    for (var j = 0; j < weeks.length; j++) {
      if (weeks[j] > maxWeek) maxWeek = weeks[j]
    }
  }
  return {
    totalWeek: maxWeek || 20,        // 总周数：根据课表自动推断，缺省 20
    startSemester: '',               // 开学时间戳：留空由 App 按校历计算
    startWithSunday: false,          // 是否周日为起始日
    showWeekend: showWeekend,        // 是否显示周末
    forenoon: 5,                     // 上午节数
    afternoon: 4,                    // 下午节数
    night: 3,                        // 晚间节数
    sections: HDU_SECTIONS
  }
}
