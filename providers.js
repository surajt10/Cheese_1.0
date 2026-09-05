// Talks to OpenAI / Gemini / Anthropic vision endpoints with plain fetch.
// A "conversation" here is a list of messages: { role: 'user'|'assistant', image?: base64 jpeg, text?: string, error?: bool }

const DEFAULT_SYSTEM_PROMPT = `You are Cheese, an assistant that only ever receives screenshots of the user's screen. The user never types to you.
For every screenshot: figure out what the user most likely needs and give it directly.
- If it shows a problem (math, physics, code, multiple choice, a question), solve it. Put the final answer FIRST in bold, then a concise worked explanation.
- If it shows code or an error, explain the fix and give corrected code.
- If it's a reading passage or document, summarise the key points.
- If several questions are visible, answer all of them, numbered.
Earlier screenshots in this conversation are context: if the new screenshot continues the same task, build on your earlier answers.
Write math in plain text / Unicode (x², √2, ∫, ≤) — never LaTeX. Use Markdown headers, lists and code blocks. Be concise; do not describe the screenshot itself unless it's ambiguous.`;

const USER_TURN_TEXT = 'Here is a new screenshot of my screen.';

/**
 * Trim history: keep at most `maxImages` of the most recent user images; older user turns become a text stub.
 * Also drops user turns that never got an answer (errors / pending) except the final one being asked now.
 */
function prepareHistory(messages, maxImages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLast = i === messages.length - 1;
    if (m.role === 'user') {
      const next = messages[i + 1];
      const answered = next && next.role === 'assistant' && !next.error && !next.pending && next.text;
      if (!answered && !isLast) continue; // skip unanswered/errored old turns
      out.push({ role: 'user', image: m.image, text: m.text || USER_TURN_TEXT });
    } else if (m.role === 'assistant') {
      if (m.error || m.pending || !m.text) continue;
      const prev = out[out.length - 1];
      if (!prev || prev.role !== 'user') continue; // must alternate
      out.push({ role: 'assistant', text: m.text });
    }
  }
  // Ensure alternation ends with the user turn being asked.
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  // Drop images beyond the budget (oldest first).
  let imgs = out.filter((m) => m.role === 'user' && m.image).length;
  for (const m of out) {
    if (imgs <= maxImages) break;
    if (m.role === 'user' && m.image) {
      delete m.image;
      m.text = '[An earlier screenshot, omitted to save space. Your answer to it follows.]';
      imgs--;
    }
  }
  return out;
}

async function callOpenAI(settings, history, systemPrompt) {
  const base = (settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) {
    if (m.role === 'user') {
      const content = [{ type: 'text', text: m.text }];
      if (m.image) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.image}`, detail: 'high' } });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'assistant', content: m.text });
    }
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openaiKey}` },
    body: JSON.stringify({ model: settings.openaiModel || 'gpt-4o', messages }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `OpenAI HTTP ${res.status}`);
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no content');
  return text;
}

async function callGemini(settings, history, systemPrompt) {
  const model = settings.geminiModel || 'gemini-2.5-flash';
  const contents = history.map((m) => {
    if (m.role === 'user') {
      const parts = [{ text: m.text }];
      if (m.image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: m.image } });
      return { role: 'user', parts };
    }
    return { role: 'model', parts: [{ text: m.text }] };
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
    body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Gemini HTTP ${res.status}`);
  const parts = json.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text) throw new Error(json.promptFeedback?.blockReason ? `Gemini blocked: ${json.promptFeedback.blockReason}` : 'Gemini returned no content');
  return text;
}

async function callAnthropic(settings, history, systemPrompt) {
  const messages = history.map((m) => {
    if (m.role === 'user') {
      const content = [];
      if (m.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.image } });
      content.push({ type: 'text', text: m.text });
      return { role: 'user', content };
    }
    return { role: 'assistant', content: m.text };
  });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: settings.anthropicModel || 'claude-sonnet-4-5', max_tokens: 4096, system: systemPrompt, messages }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Anthropic HTTP ${res.status}`);
  const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (!text) throw new Error('Anthropic returned no content');
  return text;
}

/** Main entry: returns assistant text for the conversation (last message must be the new user screenshot). */
async function askModel(settings, messages) {
  const systemPrompt = (settings.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
  const history = prepareHistory(messages, Number(settings.maxHistoryImages ?? 4));
  if (!history.length) throw new Error('Nothing to send');
  switch (settings.provider) {
    case 'gemini':
      if (!settings.geminiKey) throw new Error('No Gemini API key set. Open Settings.');
      return callGemini(settings, history, systemPrompt);
    case 'anthropic':
      if (!settings.anthropicKey) throw new Error('No Anthropic API key set. Open Settings.');
      return callAnthropic(settings, history, systemPrompt);
    case 'openai':
    default:
      if (!settings.openaiKey) throw new Error('No OpenAI API key set. Open Settings.');
      return callOpenAI(settings, history, systemPrompt);
  }
}

module.exports = { askModel, prepareHistory, DEFAULT_SYSTEM_PROMPT };
