const fetch = require("node-fetch");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini"; 


async function generateLLMExplanation(input) {
  if (!OPENAI_API_KEY) {
    console.warn("LLM skipped: OPENAI_API_KEY not set");
    return null;
  }

  const {
    ari_score,
    status,
    metrics,
    context = {}
  } = input;

  const systemPrompt = `
You are a senior software auditor explaining technical execution risk to non-technical investors.
Rules:
- Do NOT invent issues
- Do NOT change or reinterpret scores
- Only explain based on provided metrics
- Be concise, factual, and neutral
- Return valid JSON only
`;

  const userPrompt = `
Application Analysis:

ARI Score: ${ari_score}
Status: ${status}

Metrics:
- ESLint errors: ${metrics.eslint_errors}
- ESLint warnings: ${metrics.eslint_warnnings}
- Critical vulnerabilities: ${metrics.critical_vulns}
- High vulnerabilities: ${metrics.high_vulns}

Context:
- Tests present: ${context.has_tests ?? "unknown"}
- ESLint execution failed: ${context.eslint_failed ?? false}

Tasks:
1. Explain why the ARI score is at this level
2. List the top technical risks
3. Suggest concrete improvements that would most increase the ARI score

Return ONLY valid JSON with this exact structure:
{
  "summary": string,
  "top_risks": string[],
  "why_score_is_low_or_high": string[],
  "improvement_suggestions": string[]
}
`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt.trim() },
          { role: "user", content: userPrompt.trim() }
        ]
      })
    });

    if (!response.ok) {
      console.warn("LLM request failed:", response.status);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) return null;

    return JSON.parse(content);

  } catch (err) {
    console.warn("LLM explanation failed:", err.message);
    return null;
  }
}

module.exports = { generateLLMExplanation };
