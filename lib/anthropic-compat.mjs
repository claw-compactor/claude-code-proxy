/**
 * Anthropic API compatibility layer for claude-code-proxy
 * Translates /v1/messages (Anthropic format) → /v1/chat/completions (OpenAI format)
 * 
 * This allows standard Anthropic SDK clients to use the proxy directly.
 */

/**
 * Convert Anthropic /v1/messages request to OpenAI /v1/chat/completions format
 */
export function anthropicToOpenAI(body) {
  const messages = (body.messages || []).map(m => {
    // Anthropic content can be string or array of content blocks
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    } else {
      content = String(m.content || '');
    }
    return { role: m.role, content };
  });

  // Add system message if present
  if (body.system) {
    const sysText = typeof body.system === 'string' 
      ? body.system 
      : (Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : '');
    if (sysText) {
      messages.unshift({ role: 'system', content: sysText });
    }
  }

  return {
    model: body.model || 'claude-sonnet-4-20250514',
    messages,
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature ?? 1.0,
    stream: body.stream || false,
    // Pass through stop sequences
    ...(body.stop_sequences && { stop: body.stop_sequences }),
    // Pass through top_p
    ...(body.top_p != null && { top_p: body.top_p }),
  };
}

/**
 * Convert OpenAI /v1/chat/completions response to Anthropic /v1/messages format
 */
export function openAIToAnthropic(data, requestModel) {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  const usage = data.usage || {};

  return {
    id: data.id ? `msg_${data.id}` : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: message.content || '',
      }
    ],
    model: requestModel || data.model || 'claude-sonnet-4-20250514',
    stop_reason: choice.finish_reason === 'stop' ? 'end_turn' 
      : choice.finish_reason === 'length' ? 'max_tokens' 
      : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Convert OpenAI SSE streaming chunks to Anthropic streaming format
 */
export function openAIStreamToAnthropic(chunk, index, requestModel) {
  const events = [];
  
  if (index === 0) {
    // message_start
    events.push({
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: requestModel || 'claude-sonnet-4-20250514',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    });
    events.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
  }

  const choice = chunk.choices?.[0] || {};
  const delta = choice.delta || {};
  
  if (delta.content) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  if (choice.finish_reason) {
    events.push({ type: 'content_block_stop', index: 0 });
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
        stop_sequence: null,
      },
      usage: { output_tokens: 0 },
    });
    events.push({ type: 'message_stop' });
  }

  return events;
}
