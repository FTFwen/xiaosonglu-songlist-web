const MAX_BUDGET = 300000;
const CAPTAIN_COST = 1380;
const ADMIRAL_COST = 19800;
const ADMIRAL_RENEW_COST = 15800;
const AUGUST_ADMIRAL_TOTAL = ADMIRAL_COST + ADMIRAL_RENEW_COST;
const FREEZE_DRY_FOOD_COST = 60;
const FRESH_FOOD_COST = 660;
const BANNER_COST = 1;
const JOURNEY_VALUE = 500;
const EVENT_DAYS = 21;
const FAN_MAX_LEVEL = 60;
const fanLevelPrefix = [0, 0, 3, 8, 16, 28, 44, 69, 95, 123, 154, 195, 254, 335, 434, 540, 663, 802, 965, 1211, 1620, 1980, 2770, 3740, 4840, 6380, 9240, 11880, 14880, 19200, 24000, 32760, 42380, 54470, 71240, 89570, 129000, 160500, 198000, 244500, 300000, 375000, 489000, 648000, 859500, 1132500, 1477500, 1905000, 2427000, 3058500, 3804000, 4674000, 5685450, 6774150, 8044800, 9523950, 11240700, 13228200, 15523200, 18166650, 21204150];

const budgetRange = document.getElementById("budgetRange");
const budgetInput = document.getElementById("budgetInput");
const foodQuality = document.getElementById("foodQuality");
const bannerTask = document.getElementById("bannerTask");
const journeyMode = document.getElementById("journeyMode");
const sweetCount = document.getElementById("sweetCount");
const augustAdmiral = document.getElementById("augustAdmiral");
const allocationMode = document.getElementById("allocationMode");
const fanLevel = document.getElementById("fanLevel");
const fanExp = document.getElementById("fanExp");
let currentPlan = null;
for (let lv = 1; lv <= FAN_MAX_LEVEL; lv += 1) {
  const option = document.createElement("option");
  option.value = String(lv);
  option.textContent = `Lv.${lv}`;
  fanLevel.appendChild(option);
}

const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const moneyFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const dateOrder = ["8/24", "8/25", "8/26", "8/27", "8/28", "8/29", "8/30", "8/31", "9/1", "9/2", "9/3", "9/4", "9/5", "9/6", "9/7", "9/8", "9/9", "9/10", "9/11", "9/12", "9/13"];
const weekdays = ["周六", "周日", "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周一", "周二", "周三", "周四", "周五"];

const milestoneData = {
  "8/24": { title: "活动开场：建立猫粮账本", tasks: ["12:00后进入活动页", "确认舰长有效至9/4", "领取猫咪后再做付费任务"] },
  "8/25": { title: "第一次品质判断", tasks: ["先看累计猫粮是否会漏Lv.3", "普通猫粮先囤，不急着投喂"] },
  "8/26": { title: "Lv.3：第一次+200%", tasks: ["付款前先投喂至Lv.3", "确认8/26亲密度+200%已点亮"] },
  "8/30": { title: "Lv.4：宝盒5倍日", tasks: ["需要开盒才投喂至Lv.4", "不为猫粮单独追盲盒"] },
  "9/1": { title: "Lv.5前夜核对", tasks: ["确认距900成长值还差多少", "保留明日升级所需猫粮"] },
  "9/2": { title: "Lv.5：第二次+200%", tasks: ["付款前先投喂至Lv.5", "确认9/2亲密度+200%已点亮"] },
  "9/4": { title: "原舰长到期日", tasks: ["检查大航海新到期日", "未续费者明日起按普通粉丝"] },
  "9/6": { title: "Lv.6：宝盒5倍日", tasks: ["需要开盒才投喂至Lv.6", "主预算继续保留"] },
  "9/8": { title: "Lv.7前夜核对", tasks: ["确认距1600成长值还差多少", "不要提前送走明日首赠"] },
  "9/9": { title: "Lv.7：第三次+200%", tasks: ["付款前先投喂至Lv.7", "确认9/9亲密度+200%已点亮"] },
  "9/12": { title: "最终猫粮审计", tasks: ["确认明天能到2100成长值", "漏签时再决定是否升鲜食"] },
  "9/13": { title: "Lv.8：全活动主付款日", tasks: ["先签到领取第21份免费猫粮", "先投喂至Lv.8", "确认+300%与宝盒5倍点亮", "再执行当天付款顺序", "24:00前核对奖励到账"] }
};

const boxBoostDates = new Set(["8/26", "8/30", "9/2", "9/6", "9/9", "9/13"]);
const levelThresholds = [0, 100, 300, 600, 900, 1200, 1600, 2100, 3000, 6000, 10000, 16000, 24000];
const DAILY_PET_GROWTH = 50;
const BOX_COST = 330;
const BOX_SWEET_PROBABILITY = 0.4008;
const BOX_EXPECTED_GIFT_VALUE = 356.68;
const BOX_EXPECTED_SPECIAL_BONUS = 23.264;
const catGiftRanges = {
  9: [1000, 2000],
  10: [5000, 10000],
  11: [8000, 16000],
  12: [20000, 40000],
  13: [80000, 160000]
};

function clampBudget(raw) {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(MAX_BUDGET, Math.round(numeric)));
}

function identityBonus(identity) {
  if (identity === "admiral" || identity === "captain") return 0.5;
  return 0;
}

function dateBonus(date) {
  if (date === "9/13") return 3;
  if (["8/26", "9/2", "9/9"].includes(date)) return 2;
  return 0;
}

function cappedBinomialDistribution(trials, probability, cap = 10) {
  const distribution = Array(cap + 1).fill(0);
  if (trials <= 0) {
    distribution[0] = 1;
    return distribution;
  }
  const failure = 1 - probability;
  let term = Math.pow(failure, trials);
  let subtotal = 0;
  for (let successes = 0; successes < cap && successes <= trials; successes += 1) {
    if (successes > 0) term *= ((trials - successes + 1) / successes) * (probability / failure);
    distribution[successes] = term;
    subtotal += term;
  }
  distribution[cap] = Math.max(0, 1 - subtotal);
  return distribution;
}

function convolveCapped(left, right) {
  const result = Array(left.length + right.length - 1).fill(0);
  left.forEach((a, i) => right.forEach((b, j) => { result[i + j] += a * b; }));
  return result;
}

function evaluateBoxAllocation(allocations, baseCatFood, growthPerFood, petGrowth, extraGiftGrowth) {
  const sweetDistribution = allocations
    .map(count => cappedBinomialDistribution(count, BOX_SWEET_PROBABILITY))
    .reduce((combined, daily) => convolveCapped(combined, daily), [1]);
  const levelProbabilities = {};
  let expectedSweet = 0;
  let expectedGift = 0;
  sweetDistribution.forEach((probability, sweetCount) => {
    if (!probability) return;
    expectedSweet += sweetCount * probability;
    const growth = (baseCatFood + sweetCount * 3) * growthPerFood + petGrowth + extraGiftGrowth;
    const level = levelThresholds.reduce((value, threshold, index) => growth >= threshold ? index + 1 : value, 1);
    levelProbabilities[level] = (levelProbabilities[level] || 0) + probability;
    const range = catGiftRanges[level];
    if (range) expectedGift += probability * ((range[0] + range[1]) / 2);
  });
  const boxIntimacy = allocations.reduce((sum, count, index) => {
    if (!count) return sum;
    if (index === 2) return sum + count * (BOX_EXPECTED_GIFT_VALUE * 4.5 + BOX_EXPECTED_SPECIAL_BONUS);
    const firstGiftBonus = index === 1 ? BOX_EXPECTED_GIFT_VALUE : 0;
    return sum + count * (BOX_EXPECTED_GIFT_VALUE * 3.5 + BOX_EXPECTED_SPECIAL_BONUS) + firstGiftBonus;
  }, 0);
  const likelyLevel = Number(Object.entries(levelProbabilities).sort((a, b) => b[1] - a[1])[0]?.[0] || 1);
  return { allocations, sweetDistribution, levelProbabilities, expectedSweet, expectedGift, boxIntimacy, likelyLevel };
}

function chooseBoxPlan(maxBoxes, baseCatFood, growthPerFood, petGrowth, extraGiftGrowth) {
  let best = evaluateBoxAllocation([0, 0, 0], baseCatFood, growthPerFood, petGrowth, extraGiftGrowth);
  best.score = best.expectedGift + maxBoxes * BOX_COST * 4.5;
  best.boxCount = 0;
  for (let boxCount = 1; boxCount <= maxBoxes; boxCount += 1) {
    const maxEarly = Math.min(60, Math.floor(boxCount / 2));
    for (let earlyEach = 0; earlyEach <= maxEarly; earlyEach += 1) {
      const candidate = evaluateBoxAllocation([earlyEach, earlyEach, boxCount - earlyEach * 2], baseCatFood, growthPerFood, petGrowth, extraGiftGrowth);
      candidate.boxCount = boxCount;
      candidate.score = candidate.boxIntimacy + candidate.expectedGift + (maxBoxes - boxCount) * BOX_COST * 4.5;
      if (candidate.score > best.score) best = candidate;
    }
  }
  return best;
}

function buildPlanCore(total, options) {
  const augustRequested = Boolean(options.augustAdmiral);
  const augustPlan = augustRequested && total >= AUGUST_ADMIRAL_TOTAL;
  let membership = "none";
  let membershipCost = 0;
  if (augustPlan) {
    membership = "admiral";
    membershipCost = AUGUST_ADMIRAL_TOTAL;
  } else if (total >= ADMIRAL_COST) {
    membership = "admiral";
    membershipCost = ADMIRAL_COST;
  } else if (total >= CAPTAIN_COST) {
    membership = "captain";
    membershipCost = CAPTAIN_COST;
  }

  let available = total - membershipCost;
  const bannerCount = options.banner ? Math.min(EVENT_DAYS, available) : 0;
  const bannerCost = bannerCount * BANNER_COST;
  available -= bannerCost;

  const requestedFoodQuality = options.foodQuality || (options.fresh ? "fresh" : "normal");
  const qualityCost = requestedFoodQuality === "fresh" ? FRESH_FOOD_COST : requestedFoodQuality === "freeze" ? FREEZE_DRY_FOOD_COST : 0;
  let foodCost = 0;
  let actualFoodQuality = "normal";
  if (qualityCost && available >= qualityCost) {
    foodCost = qualityCost;
    actualFoodQuality = requestedFoodQuality;
    available -= foodCost;
  }

  const journeySchedules = {
    none: [],
    key: ["9/13"],
    smart: ["9/2", "9/7", "9/13"],
    max: ["8/28", "9/2", "9/7", "9/13"]
  };
  const desiredJourneyDates = journeySchedules[options.journey] || [];
  const journeyCount = Math.min(desiredJourneyDates.length, Math.floor(available / JOURNEY_VALUE));
  const journeyDates = desiredJourneyDates.slice(desiredJourneyDates.length - journeyCount);
  const journeyCost = journeyCount * JOURNEY_VALUE;
  available -= journeyCost;
  const journeyProgressBlocks = {
    none: [],
    key: [["9/7", "9/8", "9/9", "9/10", "9/11"]],
    smart: [["8/29", "8/30", "8/31", "9/1", "9/2"], ["9/3", "9/4", "9/5", "9/6", "9/7"], ["9/8", "9/9", "9/10", "9/11", "9/12"]],
    max: [["8/24", "8/25", "8/26", "8/27", "8/28"], ["8/29", "8/30", "8/31", "9/1", "9/2"], ["9/3", "9/4", "9/5", "9/6", "9/7"], ["9/8", "9/9", "9/10", "9/11", "9/12"]]
  };
  const journeyProgressMap = {};
  const modeBlocks = journeyProgressBlocks[options.journey] || [];
  desiredJourneyDates.forEach((giftDate, cycleIndex) => {
    if (!journeyDates.includes(giftDate)) return;
    (modeBlocks[cycleIndex] || []).forEach((date, dayIndex) => {
      journeyProgressMap[date] = `亲密之旅第${journeyDates.indexOf(giftDate) + 1}轮：确保今日亲密度增长（${dayIndex + 1}/5）`;
    });
  });
  const flexibleGift = Math.max(0, available);

  const earlyMembership = augustPlan || (membership !== "none" && flexibleGift >= membershipCost);
  const membershipDate = membership === "none" ? null : augustPlan ? "8/26" : earlyMembership ? "9/2" : "9/13";
  const renewalDate = augustPlan ? "9/13" : null;
  const identityLabel = augustPlan ? "八月提督回礼计划" : membership === "admiral" ? "提督计划" : membership === "captain" ? "续舰计划" : "普通粉丝";
  const transactions = [];

  const bannerDates = bannerCount ? dateOrder.slice(EVENT_DAYS - bannerCount) : [];
  bannerDates.forEach(date => transactions.push({ date, amount: 1, group: "banner", title: "粉丝手幅" }));
  journeyDates.forEach(date => transactions.push({ date, amount: JOURNEY_VALUE, group: "journey", title: "亲密之旅" }));
  if (augustPlan) {
    transactions.push({ date: "8/26", amount: ADMIRAL_COST, group: "membership", title: "8月开通提督", membership: "admiral", activatesIdentity: true });
    transactions.push({ date: "9/13", amount: ADMIRAL_RENEW_COST, group: "membership", title: "9月续费提督", membership: "admiral", activatesIdentity: false });
  } else if (membership !== "none") {
    transactions.push({ date: membershipDate, amount: membershipCost, group: "membership", title: membership === "admiral" ? "升级提督" : earlyMembership ? "续费舰长" : "重新开舰长", membership, activatesIdentity: true });
  }
  if (flexibleGift > 0) transactions.push({ date: "9/13", amount: flexibleGift, group: "gift", title: "主力确定性赠礼" });

  let activeIdentity = "captain";
  const groupIntimacy = { banner: 0, journey: 0, membership: 0, gift: 0 };
  const groupAmount = { banner: bannerCost, journey: journeyCost, membership: membershipCost, gift: flexibleGift };

  dateOrder.forEach(date => {
    if (date === "9/5" && !augustPlan && (!membershipDate || membershipDate !== "9/2")) activeIdentity = "none";
    const dayTransactions = transactions.filter(item => item.date === date).sort((a, b) => {
      if (a.activatesIdentity && !b.activatesIdentity) return -1;
      if (b.activatesIdentity && !a.activatesIdentity) return 1;
      return b.amount - a.amount;
    });
    dayTransactions.forEach((tx, index) => {
      if (tx.group === "membership") activeIdentity = tx.membership;
      tx.multiplier = 1 + identityBonus(activeIdentity) + dateBonus(date) + (tx.group === "journey" ? 0.3 : 0) + (index === 0 ? 1 : 0);
      tx.intimacy = tx.amount * tx.multiplier;
      groupIntimacy[tx.group] += tx.intimacy;
    });
  });

  const catFood = EVENT_DAYS + bannerCount + journeyCount * 3 + options.sweet * 3 + (membership !== "none" ? 10 : 0);
  const growthPerFood = actualFoodQuality === "fresh" ? 150 : actualFoodQuality === "freeze" ? 120 : 100;
  const petGrowth = EVENT_DAYS * DAILY_PET_GROWTH;
  const extraGiftGrowth = Math.max(0, Math.floor(Number(options.extraGrowth) || 0));
  const growth = catFood * growthPerFood + petGrowth + extraGiftGrowth;
  const catLevel = levelThresholds.reduce((level, threshold, index) => growth >= threshold ? index + 1 : level, 1);
  const catGiftRange = catGiftRanges[catLevel] || null;
  const catGiftMidpoint = catGiftRange ? (catGiftRange[0] + catGiftRange[1]) / 2 : 0;
  const directIntimacy = Object.values(groupIntimacy).reduce((sum, value) => sum + value, 0);
  const totalIntimacyRange = catGiftRange
    ? [directIntimacy + catGiftRange[0], directIntimacy + catGiftRange[1]]
    : [directIntimacy, directIntimacy];
  const totalIntimacyMidpoint = directIntimacy + catGiftMidpoint;
  const streamerScore = bannerCount * 5 + journeyCount * 750 + membershipCost + flexibleGift;
  const displaySteps = [];

  if (foodCost) displaySteps.push({ date: "8/25", title: `猫粮升至${actualFoodQuality === "fresh" ? "鲜食" : "冻干"}`, detail: actualFoodQuality === "fresh" ? "支付660电池，当前及后续每份猫粮按150成长值计算（+50%）。" : "支付60电池，当前及后续每份猫粮按120成长值计算（+20%）。", amount: foodCost, multiplier: 0, group: "food" });
  if (options.sweet > 0) displaySteps.push({ date: "获得即投", title: `甜蜜契约×${options.sweet}`, detail: `每个任务+3猫粮，共增加${options.sweet * 3}份；这里只记录实际开出的礼物，不假定为了任务额外购买盲盒。`, amount: 0, multiplier: 0, group: "sweet" });
  if (bannerCount) displaySteps.push({ date: "每天", title: `粉丝手幅×${bannerCount}`, detail: `每天签到后投1个；关键付款日必须先完成主付款，再投手幅，避免1电池礼物抢走每日首赠。`, amount: bannerCost, multiplier: groupIntimacy.banner / bannerCost, group: "banner" });
  if (journeyCount) displaySteps.push({ date: journeyCount === 1 ? "9/13" : "循环资格", title: `亲密之旅×${journeyCount}`, detail: `累计5个增长日只解锁打赏资格；每次实际支付500电池。每个按1.3倍获得用户亲密度，同时给3份猫粮和750主播榜亲密值。计划日期：${journeyDates.join("、")}。`, amount: journeyCost, multiplier: groupIntimacy.journey / journeyCost, group: "journey" });
  if (augustPlan) {
    const augustTx = transactions.find(tx => tx.title === "8月开通提督");
    const renewTx = transactions.find(tx => tx.title === "9月续费提督");
    displaySteps.push({ date: "8/26", title: "开通提督追8月主播回礼", detail: "先签到并投喂至Lv.3，确认+200%后，将19,800电池提督作为当天第一笔；同时完成大航海+10猫粮任务。", amount: ADMIRAL_COST, multiplier: augustTx.multiplier, group: "membership" });
    displaySteps.push({ date: "9/13", title: "续费提督", detail: flexibleGift > ADMIRAL_RENEW_COST ? "当天若另有超过15,800电池的大礼物，先送更大的那笔吃首赠；否则提前续费订单先付。" : "先投喂至Lv.8并确认+300%，再将15,800电池提前续费订单作为当天第一笔。", amount: ADMIRAL_RENEW_COST, multiplier: renewTx.multiplier, group: "membership" });
  } else if (membership !== "none") {
    displaySteps.push({ date: membershipDate, title: membership === "admiral" ? "升级提督" : earlyMembership ? "续费舰长" : "重新开舰长", detail: `${membershipDate === "9/2" ? "先解锁Lv.5再付款，保住全程在舰。" : "先签到并投喂至Lv.8，再把身份订单作为当天第一笔。"} 此订单同时完成活动期一次的“大航海+10猫粮”任务。`, amount: membershipCost, multiplier: groupIntimacy.membership / membershipCost, group: "membership" });
  }
  if (flexibleGift) displaySteps.push({ date: "9/13", title: "主力确定性赠礼", detail: augustPlan ? (flexibleGift > ADMIRAL_RENEW_COST ? "金额大于续费订单，先送这一笔吃每日首赠；续费随后完成。" : "续费订单先付；余款随后送出，继续享受提督与+300%日期加成。") : membershipDate === "9/13" ? "身份订单先付；余款随后送出，继续享受身份与+300%日期加成。" : "作为9月13日当天最大一笔并优先付款，吃到每日首赠。", amount: flexibleGift, multiplier: groupIntimacy.gift / flexibleGift, group: "gift" });

  const notes = [];
  if (catGiftRange) notes.push(`按当前任务配置预计达到Lv.${catLevel}，9月13日可领取1电池喵崽馈赠，随机亲密度${fmt.format(catGiftRange[0])}～${fmt.format(catGiftRange[1])}；右侧总亲密度已按区间中点${fmt.format(catGiftMidpoint)}计入，完整范围另行列出。`);
  if (augustRequested && !augustPlan) notes.push(`追8月提督回礼场景至少需要${fmt.format(AUGUST_ADMIRAL_TOTAL)}电池；当前预算不足，暂按普通单次身份方案计算。`);
  if (augustPlan) notes.push("已锁定8/26开提督19,800电池和9/13提前续费15,800电池：8月订单吃Lv.3的+200%，9月订单吃Lv.8的+300%；两次都尽量作为各自当天最大的一笔。");
  if (!options.banner) notes.push("完整签到已经按时满足Lv.3/5/7/8，默认跳过粉丝手幅猫粮任务；担心漏签时再开启21电池容错。");
  if (bannerCount < EVENT_DAYS && options.banner) notes.push(`预算只能覆盖${bannerCount}/21天粉丝手幅，已优先放到后段高倍率日期；再增加${EVENT_DAYS - bannerCount}电池即可补齐。`);
  if (requestedFoodQuality !== "normal" && !foodCost) notes.push(`身份和任务支出后不足${fmt.format(qualityCost)}电池，未安排${requestedFoodQuality === "fresh" ? "鲜食" : "冻干"}升级，按普通猫粮计算。`);
  if (options.journey === "none") notes.push("未安排亲密之旅；全部预算仍集中到9月13日普通赠礼，不获得亲密之旅额外30%、猫粮和榜单加分。");
  if (options.journey === "key") notes.push("计划9/7—9/11累计5个增长日，解锁后在48小时内留到9/13支付500电池赠送；它比同日500电池普通礼物多150用户亲密度、250榜亲密值和3份猫粮。");
  if (options.journey === "smart") notes.push("选择3次循环会从9月13日普通赠礼中划出1500电池；较早两次日期倍率更低，适合兼顾猫粮和主播榜，不是用户亲密度最高方案。");
  if (options.journey === "max") notes.push("选择4次循环会占用2000电池；次数最多、猫粮和主播榜收益最高，但低倍率日期会降低累计用户亲密度。");
  if (journeyCount < desiredJourneyDates.length) notes.push(`当前身份及任务支出后只够支付${journeyCount}/${desiredJourneyDates.length}次亲密之旅，未安排的资格不要解锁，以免48小时后清空进度。`);
  if (!augustPlan && membershipDate === "9/13") notes.push("9/4后会短暂离舰；这是用后段猫咪随机奖励的在舰加成，换提督/舰长订单在9月13日吃最高倍率。");
  notes.push(`甜蜜契约已按实际投喂${options.sweet}个、增加${options.sweet * 3}份猫粮；它依赖羁绊宝盒随机开出，盲盒购入成本没有自动并入预算。`);

  let title = "免费签到已经足够Lv.8";
  if (augustPlan) title = "8月26日开提督，9月13日续费提督";
  else if (membership === "admiral") title = earlyMembership ? "9月2日上提督，9月13日付余款" : "9月13日先上提督，再付余款";
  else if (membership === "captain") title = earlyMembership ? "9月2日续舰，9月13日付余款" : "9月13日重新开舰";
  else if (total > 0) title = "先做高效率猫粮任务，余款留到9月13日";

  return {
    total,
    identity: identityLabel,
    title,
    summary: notes.join(" "),
    steps: displaySteps.sort((a, b) => {
      const dateRank = { "8/25": 1, "每天": 2, "9/2": 3, "9/13": 4 };
      const groupRank = { food: 1, banner: 2, membership: 3, gift: 4, journey: 5, sweet: 6 };
      return ((dateRank[a.date] || 3) - (dateRank[b.date] || 3)) || ((groupRank[a.group] || 9) - (groupRank[b.group] || 9));
    }),
    intimacy: totalIntimacyMidpoint,
    paidIntimacy: directIntimacy,
    groupIntimacy,
    flexibleGift,
    totalIntimacyRange,
    streamerScore,
    ratio: total ? totalIntimacyMidpoint / total : 0,
    ratioRange: total ? [totalIntimacyRange[0] / total, totalIntimacyRange[1] / total] : [0, 0],
    spent: membershipCost + bannerCost + foodCost + journeyCost + flexibleGift,
    catFood,
    growth,
    petGrowth,
    extraGiftGrowth,
    catLevel,
    catGiftRange,
    catGiftMidpoint,
    bannerCount,
    foodCost,
    journeyCost,
    bannerCost,
    membershipCost,
    growthPerFood,
    foodQuality: actualFoodQuality,
    requestedFoodQuality,
    bannerEnabled: options.banner,
    bannerDates: new Set(bannerDates),
    journeyMode: options.journey,
    journeyCount,
    journeyDates: new Set(journeyDates),
    journeyProgressMap,
    membershipDate,
    renewalDate,
    augustPlan,
    membership,
    transactionDates: new Set(transactions.map(item => item.date))
  };
}

function buildCatAllocationForQuality(total, options, quality) {
  const forcedOptions = { ...options, banner: true, foodQuality: quality, journey: "max", allocation: "cat" };
  const prepared = buildPlanCore(total, forcedOptions);
  const maxBoxes = Math.floor(prepared.flexibleGift / BOX_COST);
  const boxPlan = chooseBoxPlan(maxBoxes, prepared.catFood, prepared.growthPerFood, prepared.petGrowth, prepared.extraGiftGrowth);
  const boxCost = boxPlan.boxCount * BOX_COST;
  const directRemainder = prepared.flexibleGift - boxCost;
  const committedBeforeFlexible = total - prepared.flexibleGift;
  const skeleton = buildPlanCore(committedBeforeFlexible + directRemainder, forcedOptions);
  const paidIntimacy = skeleton.paidIntimacy + boxPlan.boxIntimacy;
  const levelEntries = Object.entries(boxPlan.levelProbabilities).filter(([, probability]) => probability > 1e-9);
  const minLevel = levelEntries.length ? Math.min(...levelEntries.map(([level]) => Number(level))) : skeleton.catLevel;
  const maxLevel = levelEntries.length ? Math.max(...levelEntries.map(([level]) => Number(level))) : skeleton.catLevel;
  const minGiftRange = catGiftRanges[minLevel];
  const maxGiftRange = catGiftRanges[maxLevel];
  const giftRange = minGiftRange && maxGiftRange ? [minGiftRange[0], maxGiftRange[1]] : null;
  const totalIntimacy = paidIntimacy + boxPlan.expectedGift;
  const totalRange = giftRange ? [paidIntimacy + giftRange[0], paidIntimacy + giftRange[1]] : [paidIntimacy, paidIntimacy];
  const expectedCatFood = skeleton.catFood + boxPlan.expectedSweet * 3;
  const expectedGrowth = expectedCatFood * skeleton.growthPerFood + skeleton.petGrowth + skeleton.extraGiftGrowth;
  const levelSummary = Object.entries(boxPlan.levelProbabilities)
    .filter(([level, probability]) => Number(level) >= 9 && probability >= 0.005)
    .map(([level, probability]) => `Lv.${level} ${(probability * 100).toFixed(1)}%`)
    .join("、");
  const boxDates = ["9/2", "9/9", "9/13"];
  const boxDateText = boxPlan.allocations.map((count, index) => count ? `${boxDates[index]} ${count}盒` : "").filter(Boolean).join("、");
  const steps = skeleton.steps.filter(step => step.group !== "gift");
  if (directRemainder > 0) steps.push({ date: "9/13", title: "剩余确定性赠礼", detail: "冲级预算取整到330电池/盒后剩余的电池，继续在9月13日赠送。", amount: directRemainder, multiplier: skeleton.groupIntimacy.gift / directRemainder, group: "gift" });
  if (boxPlan.boxCount > 0) steps.push({ date: "分批开盒", title: `羁绊宝盒×${boxPlan.boxCount}`, detail: `按甜蜜契约40.08%和每日最多计10次任务建模，建议分配：${boxDateText}。预计获得${boxPlan.expectedSweet.toFixed(1)}个计入任务的甜蜜契约。`, amount: boxCost, displayAmount: `${fmt.format(boxCost)} 电池`, multiplier: boxPlan.boxIntimacy / boxCost, group: "box" });
  const transactionDates = new Set(skeleton.transactionDates);
  boxPlan.allocations.forEach((count, index) => { if (count) transactionDates.add(boxDates[index]); });
  return {
    ...skeleton,
    total,
    title: `自动分配：${quality === "fresh" ? "鲜食" : quality === "freeze" ? "冻干" : "普通"}＋${boxPlan.boxCount}盒冲猫`,
    summary: `猫粮品质选择${quality === "fresh" ? "鲜食（660电池/150成长）" : quality === "freeze" ? "冻干（60电池/120成长）" : "普通（0电池/100成长）"}。主力余款已真实拆成羁绊宝盒和确定性赠礼。预计等级分布：${levelSummary || `Lv.${boxPlan.likelyLevel}`}；喵崽馈赠期望值${fmt.format(Math.round(boxPlan.expectedGift))}亲密度。 ${skeleton.summary}`,
    steps,
    intimacy: totalIntimacy,
    paidIntimacy,
    totalIntimacyRange: totalRange,
    ratio: total ? totalIntimacy / total : 0,
    ratioRange: total ? [totalRange[0] / total, totalRange[1] / total] : [0, 0],
    spent: skeleton.spent + boxCost,
    streamerScore: Math.round(skeleton.streamerScore + boxPlan.boxCount * BOX_EXPECTED_GIFT_VALUE),
    catFood: expectedCatFood,
    growth: expectedGrowth,
    catLevel: boxPlan.likelyLevel,
    catGiftRange: giftRange,
    catGiftMidpoint: boxPlan.expectedGift,
    boxCount: boxPlan.boxCount,
    boxCost,
    boxAllocations: boxPlan.allocations,
    expectedSweet: boxPlan.expectedSweet,
    levelProbabilities: boxPlan.levelProbabilities,
    allocationChoice: "cat",
    transactionDates
  };
}

function foodQualityCandidates(options) {
  const requested = options.foodQuality || "auto";
  return requested === "auto" ? ["normal", "freeze", "fresh"] : [requested];
}

function buildBestDirectPlan(total, options) {
  return foodQualityCandidates(options)
    .map(quality => buildPlanCore(total, { ...options, foodQuality: quality, allocation: "direct" }))
    .reduce((best, candidate) => !best || candidate.intimacy > best.intimacy ? candidate : best, null);
}

function buildCatAllocationPlan(total, options) {
  return foodQualityCandidates(options)
    .map(quality => buildCatAllocationForQuality(total, options, quality))
    .reduce((best, candidate) => !best || candidate.intimacy > best.intimacy ? candidate : best, null);
}

function buildPlan(total, options) {
  const mode = options.allocation || "auto";
  const directPlan = buildBestDirectPlan(total, options);
  if (mode === "direct") return { ...directPlan, allocationChoice: "direct" };
  const catPlan = buildCatAllocationPlan(total, options);
  if (mode === "cat" || catPlan.intimacy > directPlan.intimacy) return catPlan;
  return {
    ...directPlan,
    allocationChoice: "direct",
    summary: `自动比较后，当前预算直接赠礼的预计总亲密度比冲猫方案高${fmt.format(Math.round(directPlan.intimacy - catPlan.intimacy))}，因此余款仍留在9月13日。 ${directPlan.summary}`
  };
}

function renderPlan(plan) {
  document.getElementById("yuanValue").textContent = `¥${moneyFmt.format(plan.total / 10)}`;
  document.getElementById("strategyTitle").textContent = plan.title;
  document.getElementById("identityBadge").textContent = plan.identity;
  document.getElementById("strategySummary").textContent = plan.summary;
  document.getElementById("returnValue").textContent = fmt.format(Math.round(plan.intimacy));
  document.getElementById("returnRatio").textContent = `${plan.ratio.toFixed(2)}×（范围 ${plan.ratioRange[0].toFixed(2)}～${plan.ratioRange[1].toFixed(2)}×）`;
  document.getElementById("spentValue").textContent = `${fmt.format(plan.spent)} / ${fmt.format(plan.total)} 电池`;
  document.getElementById("streamerScoreValue").textContent = fmt.format(plan.streamerScore);
  document.getElementById("totalRangeValue").textContent = `${fmt.format(Math.round(plan.totalIntimacyRange[0]))}～${fmt.format(Math.round(plan.totalIntimacyRange[1]))}`;
  document.getElementById("paidIntimacyValue").textContent = fmt.format(Math.round(plan.paidIntimacy));
  document.getElementById("catFoodValue").textContent = `${plan.catFood}份`;
  document.getElementById("growthValue").textContent = `${fmt.format(plan.growth)} · Lv.${plan.catLevel}`;
  document.getElementById("catGiftValue").textContent = plan.catGiftRange ? `${fmt.format(plan.catGiftRange[0])}～${fmt.format(plan.catGiftRange[1])}` : "未达到Lv.9";
  document.getElementById("catGiftMidValue").textContent = plan.catGiftMidpoint ? fmt.format(Math.round(plan.catGiftMidpoint)) : "0";
  const levelProbabilityText = plan.levelProbabilities
    ? Object.entries(plan.levelProbabilities).filter(([level, probability]) => Number(level) >= 9 && probability >= 0.005).map(([level, probability]) => `Lv.${level} ${(probability * 100).toFixed(1)}%`).join(" / ")
    : `Lv.${plan.catLevel} 100%`;
  document.getElementById("levelProbabilityValue").textContent = levelProbabilityText || `Lv.${plan.catLevel}`;
  const qualityName = plan.foodQuality === "fresh" ? "鲜食" : plan.foodQuality === "freeze" ? "冻干" : "普通";
  document.getElementById("allocationDecisionValue").textContent = plan.allocationChoice === "cat" ? `${qualityName}＋${plan.boxCount || 0}盒` : `${qualityName}＋9月13日直投`;

  const paymentSteps = document.getElementById("paymentSteps");
  if (!plan.steps.length) {
    paymentSteps.innerHTML = `<div class="payment-step"><span class="payment-date">全周期</span><i class="step-dot"></i><div class="step-copy"><strong>不安排付费任务</strong><span>每日签到可得21份猫粮，普通品质正好达到Lv.8。</span></div><div class="step-amount"><b>0 电池</b><small>免费路线</small></div></div>`;
  } else {
    paymentSteps.innerHTML = plan.steps.map(item => `
      <div class="payment-step">
        <span class="payment-date">${item.date}</span><i class="step-dot"></i>
        <div class="step-copy"><strong>${item.title}</strong><span>${item.detail}</span></div>
        <div class="step-amount"><b>${item.displayAmount || `${fmt.format(item.amount)} 电池`}</b><small>${item.multiplier ? `用户亲密度约 ${item.multiplier.toFixed(2)}×` : item.group === "sweet" ? "实际获得后记录" : "成长值支出"}</small></div>
      </div>`).join("");
  }
  renderTimeline(plan);
}

function renderTimeline(plan) {
  document.getElementById("dailyTimeline").innerHTML = dateOrder.map((date, index) => {
    const milestone = milestoneData[date];
    const tasks = [`签到：+1猫粮`, `每日撸猫：+50成长值`, `累计10条弹幕（榜单+10，不给猫粮）`];
    if (milestone) tasks.push(...milestone.tasks);
    if (plan.foodCost && date === "8/25") tasks.push(`花${fmt.format(plan.foodCost)}电池升级${plan.foodQuality === "fresh" ? "鲜食" : "冻干"}后再投喂`);
    if (plan.membershipDate === date) tasks.push(`${plan.membership === "admiral" ? "开通提督" : "开通/续费舰长"}：+10猫粮（活动期一次）`);
    if (plan.renewalDate === date) tasks.push("提前续费提督15,800电池：不重复获得大航海猫粮任务");
    if (plan.journeyProgressMap[date]) tasks.push(plan.journeyProgressMap[date]);
    if (plan.journeyDates.has(date)) tasks.push(`48小时资格内支付500电池赠送亲密之旅：+30%用户亲密度/+3猫粮`);
    else if (plan.journeyMode === "none") tasks.push("亲密之旅：未规划（会错过额外30%与猫粮）");
    if (plan.bannerDates.has(date)) tasks.push(`${plan.transactionDates.has(date) && ["8/26", "9/2", "9/9", "9/13"].includes(date) ? "主付款后再投" : "投喂"}粉丝手幅×1：1电池/+1猫粮`);
    else if (!plan.bannerEnabled) tasks.push("粉丝手幅任务：跳过（签到粮已够）");
    tasks.push("甜蜜契约：每投1个+3猫粮，单日最多10次；不为任务追盒");
    const boxIndex = ["9/2", "9/9", "9/13"].indexOf(date);
    const plannedBoxes = boxIndex >= 0 && plan.boxAllocations ? plan.boxAllocations[boxIndex] : 0;
    if (plannedBoxes) tasks.push(`自动冲级：开羁绊宝盒×${plannedBoxes}，甜蜜契约获得即投喂`);
    else if (boxBoostDates.has(date)) tasks.push("今日有羁绊宝盒爆率加成，若本来开盒再顺带做");
    if (date === "9/13") tasks.push(`领取Lv.${plan.catLevel}喵崽馈赠：${plan.catGiftRange ? `${fmt.format(plan.catGiftRange[0])}～${fmt.format(plan.catGiftRange[1])}随机亲密度` : "需先达到Lv.9"}`);

    const hasPayment = plan.transactionDates.has(date) || (plan.foodCost && date === "8/25");
    const classes = ["day-row", milestone ? "is-milestone" : "", hasPayment ? "has-payment" : ""].filter(Boolean).join(" ");
    const tags = `${milestone ? `<span class="day-tag">节点</span>` : ""}${hasPayment ? `<span class="day-tag pay">本日付费任务</span>` : ""}`;
    const chips = tasks.map(task => {
      const pay = task.includes("电池") || task.includes("提督") || task.includes("续费舰长");
      const important = task.includes("投喂至") || task.includes("确认") || task.includes("先付") || task.includes("主付款后") || task.includes("亲密之旅");
      return `<span class="task-chip${pay ? " pay" : important ? " important" : ""}">${task}</span>`;
    }).join("");
    return `<article class="${classes}"><div class="day-date">${date}<small>${weekdays[index]}</small></div><div class="day-track"><i class="day-marker"></i></div><div class="day-content"><div class="day-title"><strong>${milestone ? milestone.title : "签到、领粮、核对库存"}</strong>${tags}</div><div class="task-list">${chips}</div></div></article>`;
  }).join("");
}

function computeFanPrediction(level, exp, intimacy) {
  const prefix = fanLevelPrefix;
  const maxLevel = FAN_MAX_LEVEL;
  let warning = "";
  const needForCurrent = prefix[level + 1] - prefix[level];
  let clampedExp = Math.max(0, Math.floor(Number(exp) || 0));
  if (clampedExp >= needForCurrent) {
    warning = `当前经验已达升 Lv.${level + 1} 所需（${fmt.format(needForCurrent)}），建议把等级调到 Lv.${level + 1} 更准确。`;
    clampedExp = Math.max(0, needForCurrent - 1);
  }
  const startCumulative = prefix[level] + clampedExp;
  const delta = Math.max(0, Math.round(intimacy));
  const endCumulative = startCumulative + delta;
  let resultLevel = level;
  for (let lv = level; lv <= maxLevel; lv += 1) {
    if (endCumulative >= prefix[lv]) resultLevel = lv;
    else break;
  }
  let toNext = null;
  let beyond = false;
  if (resultLevel < maxLevel) {
    toNext = prefix[resultLevel + 1] - endCumulative;
  } else {
    beyond = endCumulative >= prefix[maxLevel];
  }
  return { startCumulative, delta, endCumulative, resultLevel, toNext, beyond, warning };
}

function renderFanPrediction(plan) {
  if (!plan) return;
  const level = Number(fanLevel.value) || 1;
  const exp = Number(fanExp.value) || 0;
  const pred = computeFanPrediction(level, exp, plan.intimacy);
  document.getElementById("fanResultLevel").textContent = `Lv.${pred.resultLevel}`;
  document.getElementById("fanResultNote").textContent = pred.beyond
    ? "已超过表格记录范围（此表只收录到 60 级）"
    : pred.warning || "上方攻略预计总亲密度已自动带入";
  document.getElementById("fanStartExp").textContent = fmt.format(pred.startCumulative);
  document.getElementById("fanDelta").textContent = `+ ${fmt.format(pred.delta)}`;
  document.getElementById("fanEndExp").textContent = fmt.format(pred.endCumulative);
  document.getElementById("fanToNext").textContent = pred.toNext !== null ? `还差 ${fmt.format(pred.toNext)}` : "已达表格上限";
}

function update(raw) {
  const budget = clampBudget(raw);
  budgetRange.value = budget;
  budgetInput.value = budget;
  budgetRange.style.setProperty("--fill", `${(budget / MAX_BUDGET) * 100}%`);
  localStorage.setItem("intimacyBudget", String(budget));
  localStorage.setItem("foodQuality", foodQuality.value);
  localStorage.setItem("bannerTask", bannerTask.checked ? "1" : "0");
  localStorage.setItem("journeyMode", journeyMode.value);
  localStorage.setItem("sweetCount", sweetCount.value);
  localStorage.setItem("augustAdmiral", augustAdmiral.checked ? "1" : "0");
  localStorage.setItem("allocationMode", allocationMode.value);
  const sweet = Math.max(0, Math.min(210, Math.floor(Number(sweetCount.value) || 0)));
  sweetCount.value = sweet;
  const plan = buildPlan(budget, { foodQuality: foodQuality.value, banner: bannerTask.checked, journey: journeyMode.value, sweet, augustAdmiral: augustAdmiral.checked, extraGrowth: 0, allocation: allocationMode.value });
  currentPlan = plan;
  renderPlan(plan);
  renderFanPrediction(plan);
}

budgetRange.addEventListener("input", event => {
  const budget = clampBudget(event.target.value);
  budgetInput.value = budget;
  budgetRange.style.setProperty("--fill", `${(budget / MAX_BUDGET) * 100}%`);
  document.getElementById("yuanValue").textContent = `¥${moneyFmt.format(budget / 10)}`;
});
budgetRange.addEventListener("change", event => update(event.target.value));
budgetInput.addEventListener("change", event => update(event.target.value));
budgetInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.currentTarget.blur(); update(event.currentTarget.value); } });
foodQuality.addEventListener("change", () => update(budgetRange.value));
bannerTask.addEventListener("change", () => update(budgetRange.value));
journeyMode.addEventListener("change", () => update(budgetRange.value));
sweetCount.addEventListener("change", () => update(budgetRange.value));
augustAdmiral.addEventListener("change", () => update(budgetRange.value));
allocationMode.addEventListener("change", () => update(budgetRange.value));
fanLevel.addEventListener("change", () => { localStorage.setItem("fanLevel", fanLevel.value); renderFanPrediction(currentPlan); });
fanExp.addEventListener("change", () => { localStorage.setItem("fanExp", fanExp.value); renderFanPrediction(currentPlan); });

const storedBudget = localStorage.getItem("intimacyBudget");
const modelVersion = localStorage.getItem("missionModelVersion");
if (modelVersion === "12") {
  const storedFoodQuality = localStorage.getItem("foodQuality");
  const storedBanner = localStorage.getItem("bannerTask");
  const storedJourney = localStorage.getItem("journeyMode");
  const storedSweet = localStorage.getItem("sweetCount");
  const storedAugustAdmiral = localStorage.getItem("augustAdmiral");
  const storedAllocationMode = localStorage.getItem("allocationMode");
  if (storedFoodQuality) foodQuality.value = storedFoodQuality;
  if (storedBanner !== null) bannerTask.checked = storedBanner === "1";
  if (storedJourney) journeyMode.value = storedJourney;
  if (storedSweet !== null) sweetCount.value = storedSweet;
  if (storedAugustAdmiral !== null) augustAdmiral.checked = storedAugustAdmiral === "1";
  if (storedAllocationMode) allocationMode.value = storedAllocationMode;
} else {
  foodQuality.value = "auto";
  bannerTask.checked = false;
  augustAdmiral.checked = true;
  journeyMode.value = "key";
  sweetCount.value = 0;
  allocationMode.value = "auto";
  localStorage.setItem("missionModelVersion", "12");
}
const storedFanLevel = localStorage.getItem("fanLevel");
const storedFanExp = localStorage.getItem("fanExp");
if (storedFanLevel) fanLevel.value = storedFanLevel; else fanLevel.value = "21";
if (storedFanExp !== null) fanExp.value = storedFanExp;
update(modelVersion === "12" && storedBudget !== null ? storedBudget : 36100);
