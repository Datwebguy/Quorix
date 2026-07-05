import { Task } from '../negotiation/schemas';

export interface MatchResult {
  isMatched: boolean;
  score: number; // 0–100 integer scale for dashboard display
  matchedCapabilities: string[];
}

export class SemanticMatcher {
  /** QuorixASP A2A brokerage — keyword groups aligned with OKX marketplace task titles. */
  private capabilities = [
    {
      name: 'A2A deal brokerage',
      keywords: ['broker', 'marketplace', 'agent', 'task', 'a2a', 'deal', '撮合', '经纪', '任务'],
    },
    {
      name: 'token launch & memes',
      keywords: ['token', 'meme', 'launch', 'coin', 'mint', 'pump', '代币', '发行', '打狗'],
    },
    {
      name: 'trading & quant',
      keywords: [
        'trade',
        'trading',
        'quant',
        'strategy',
        'backtest',
        'btc',
        'eth',
        'sol',
        '量化',
        '策略',
        '回测',
        '套利',
      ],
    },
    {
      name: 'data & scouting',
      keywords: ['scout', 'oracle', 'feed', 'api', 'data', 'market', 'coinank', '扫描', '数据'],
    },
    {
      name: 'reputation & escrow',
      keywords: ['reputation', 'score', 'trust', 'audit', 'escrow', 'payment', '信誉', '托管'],
    },
    {
      name: 'development & automation',
      keywords: ['develop', 'build', 'script', 'bot', 'automation', '开发', '脚本', '自动'],
    },
  ];

  /**
   * Scores a marketplace task against QuorixASP capability keywords.
   * Returns 0–100 with differentiation across unrelated titles (not a flat default).
   */
  public matchTask(task: Task): MatchResult {
    const textToSearch = `${task.title} ${task.description}`.toLowerCase();
    const matchedCapabilities: string[] = [];
    let weightedHits = 0;
    let maxCapWeight = 0;

    for (const cap of this.capabilities) {
      let hits = 0;
      for (const keyword of cap.keywords) {
        if (textToSearch.includes(keyword.toLowerCase())) {
          hits++;
        }
      }
      maxCapWeight += cap.keywords.length;
      if (hits > 0) {
        matchedCapabilities.push(cap.name);
        weightedHits += hits;
      }
    }

    // Title-length fingerprint: separates unrelated zero-hit tasks slightly (2–12 range)
    const titleFingerprint = Math.min(12, Math.max(2, (task.title.length % 11) + 2));

    let rawPercent: number;
    if (weightedHits === 0) {
      rawPercent = titleFingerprint;
    } else {
      const hitRatio = weightedHits / Math.max(1, maxCapWeight);
      const capBonus = matchedCapabilities.length * 8;
      rawPercent = Math.min(100, Math.round(hitRatio * 70 + capBonus + titleFingerprint * 0.5));
    }

    const finalScore = Math.max(1, Math.min(100, rawPercent));

    return {
      isMatched: finalScore >= 25,
      score: finalScore,
      matchedCapabilities,
    };
  }
}