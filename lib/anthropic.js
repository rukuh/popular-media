const config = require('../config')

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'

async function prompt (system, content) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://github.com/sjlu/popular-movies',
      'X-Title': 'popular-media'
    },
    body: JSON.stringify({
      model: 'google/gemini-3-flash-preview',
      max_tokens: 4096,
      temperature: 0.0,
      messages: [
        {
          role: 'system',
          content: system
        },
        {
          role: 'user',
          content
        }
      ]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`)
  }

  const result = await response.json()
  const responseText = result.choices[0].message.content

  const lines = responseText.split('\n').map(line => line.trim())

  const bodyStartIndex = lines.findIndex(line => line === '```json' || line === '```')
  if (bodyStartIndex === -1) {
    throw new Error('Response does not contain a code block')
  }

  const bodyEndIndex = lines.indexOf('```', bodyStartIndex + 1)
  if (bodyEndIndex === -1) {
    throw new Error('Response does not contain a closing code block')
  }

  const data = JSON.parse(lines.slice(bodyStartIndex + 1, bodyEndIndex).join('\n').trim())
  return data
}

module.exports = { prompt }
