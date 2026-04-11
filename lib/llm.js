// lib/llm.js — Unified LLM caller with Groq → Gemini fallback chain
// §5.3 (Groq call pattern) · §3 (Gemini as backup)
// All calls use temperature: 0.0 and JSON mode.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

/**
 * Call Groq (llama-3.3-70b-versatile) with JSON mode.
 * Returns parsed JSON or throws.
 */
async function callGroq(systemPrompt, userPrompt) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Groq ${response.status}: ${txt.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned empty content');
  return JSON.parse(content);
}

/**
 * Call Gemini (gemini-1.5-flash) requesting JSON output.
 * Returns parsed JSON or throws.
 */
async function callGemini(systemPrompt, userPrompt) {
  const url = `${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
      }],
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Gemini ${response.status}: ${txt.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini returned empty content');
  return JSON.parse(content);
}

/**
 * Unified LLM call with Groq → Gemini fallback.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<object>} Parsed JSON from the LLM
 */
export async function callLLM(systemPrompt, userPrompt) {
  // Primary: Groq
  try {
    const result = await callGroq(systemPrompt, userPrompt);
    console.log('[llm] provider: groq');
    return result;
  } catch (groqErr) {
    console.warn('[llm] groq failed, trying gemini:', groqErr.message);
  }

  // Fallback: Gemini
  const result = await callGemini(systemPrompt, userPrompt);
  console.log('[llm] provider: gemini');
  return result;
}
