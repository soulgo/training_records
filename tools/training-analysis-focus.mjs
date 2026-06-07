const defaultQuestion = '请根据最近训练、体脂、饮食数据给出今天/明天的训练建议';
const defaultTrainingGoal = '增肌减腹：优先增加或保住骨骼肌/瘦体重，同时通过整体减脂降低腰围和腹部脂肪；不追求单纯掉体重或局部减脂。';

export function normalizeAnalysisQuestion(question) {
  const normalized = question?.trim();
  return normalized || defaultQuestion;
}

export function normalizeTrainingGoal(trainingGoal) {
  const normalized = trainingGoal?.trim();
  return normalized || defaultTrainingGoal;
}

export function inferTrainingAnalysisFocus(question) {
  const normalized = normalizeAnalysisQuestion(question);
  const intent = inferAnalysisIntent(normalized);
  const responseMode = responseModeForIntent(intent);
  const hasSevenDayRequest = hasRecentSevenDayRequest(normalized);
  const hasThirtyDayRequest = hasRecentThirtyDayRequest(normalized);
  const hasNearTermTrainingRequest = hasNearTermTrainingIntent(normalized);

  // Returns compact focus: w=window, m=measurementTrend, q=timeframe, p=policy code.
  // Policy codes map to full text in the system prompt (回答时间窗策略 section).
  if (hasSevenDayRequest && !hasThirtyDayRequest) {
    return {
      w: 'recent7',
      m: 'measurementTrend7',
      q: '最近7天',
      p: 'no_recent30',
      intent,
      responseMode,
    };
  }

  if (hasThirtyDayRequest && !hasSevenDayRequest) {
    return {
      w: 'recent30',
      m: 'measurementTrend30',
      q: '最近30天',
      p: 'recent7_supplement',
      intent,
      responseMode,
    };
  }

  if (hasSevenDayRequest && hasThirtyDayRequest) {
    return {
      w: 'explicit_mixed',
      m: 'explicit_mixed',
      q: '用户同时点名最近7天和最近30天',
      p: 'explicit_mixed',
      intent,
      responseMode,
    };
  }

  if (hasNearTermTrainingRequest) {
    return {
      w: 'recent7',
      m: 'measurementTrend7',
      q: '今天/明天训练建议',
      p: 'near_term',
      intent,
      responseMode,
    };
  }

  return {
    w: 'recent7',
    m: 'measurementTrend7',
    q: intent === 'pain_discomfort' ? '疼痛/不适问题默认最近7天' : '默认最近7天',
    p: 'default_recent7',
    intent,
    responseMode,
  };
}

function hasRecentSevenDayRequest(question) {
  return /(?:最近|近|过去|前|这|本)?\s*(?:7|七)\s*天/u.test(question)
    || /(?:最近|近|过去|这|本)?\s*(?:一|1)\s*周/u.test(question);
}

function hasRecentThirtyDayRequest(question) {
  return /(?:最近|近|过去|前)?\s*(?:30|三十)\s*天/u.test(question)
    || /(?:最近|近|过去)?\s*(?:一|1)\s*个?\s*月/u.test(question);
}

function hasNearTermTrainingIntent(question) {
  return /今天|明天|今晚|明早|下一次|下次|怎么练|训练安排|训练建议|计划/u.test(question);
}

function inferAnalysisIntent(question) {
  if (hasPainDiscomfortIntent(question)) {
    return 'pain_discomfort';
  }
  if (hasNutritionIntent(question)) {
    return 'nutrition';
  }
  if (hasBodyCompositionIntent(question)) {
    return 'body_composition';
  }
  if (hasRecoveryIntent(question)) {
    return 'recovery';
  }
  if (hasNearTermTrainingIntent(question) || hasTrainingPlanIntent(question)) {
    return 'training_plan';
  }
  return 'general';
}

function responseModeForIntent(intent) {
  return {
    training_plan: 'training_plan',
    nutrition: 'nutrition_review',
    body_composition: 'body_composition_review',
    recovery: 'recovery_review',
    pain_discomfort: 'symptom_triage',
    general: 'general_review',
  }[intent] ?? 'general_review';
}

function hasPainDiscomfortIntent(question) {
  const symptomPattern = /疼|痛|酸痛|酸胀|酸疼|发酸|肿|红肿|发热|麻|刺痛|抽筋|拉伤|扭伤|损伤|不适|僵硬|受限/u;
  if (symptomPattern.test(question)) {
    return true;
  }

  const symptomContext = '怎么回事|啥原因|什么原因|原因|恢复|休息|按压|伸直|疼|痛|酸|肿|麻|刺痛|抽筋|僵硬|不适|红肿|发热|受限';
  return new RegExp(
    `(?:肱二头肌|二头肌|右臂|左臂|手臂|肩|肘|腕|膝|踝|腰|背|臀|髋).*(?:${symptomContext})|(?:${symptomContext}).*(?:肱二头肌|二头肌|右臂|左臂|手臂|肩|肘|腕|膝|踝|腰|背|臀|髋)`,
    'u',
  ).test(question);
}

function hasNutritionIntent(question) {
  return /饮食|吃|摄入|热量|蛋白|碳水|脂肪|餐|早餐|午餐|晚餐|加餐|饿|饱|补剂|营养/u.test(question);
}

function hasBodyCompositionIntent(question) {
  return /体重|体脂|骨骼肌|肌肉|腰围|腹|肚子|减脂|增肌|掉秤|瘦|胖|围度|BMI/u.test(question);
}

function hasRecoveryIntent(question) {
  return /恢复|疲劳|累|休息|睡眠|精神|状态|过度训练|乏力|心率|压力/u.test(question);
}

function hasTrainingPlanIntent(question) {
  return /训练|力量|有氧|HIIT|骑行|跑步|爬楼|哑铃|拉伸|练/u.test(question);
}
