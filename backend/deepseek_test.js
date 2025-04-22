const axios = require('axios');
require('dotenv').config();

async function testDeepSeek() {
  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Explain how transformers work in 2 lines.' }
        ],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ DeepSeek Response:\n');
    console.log(response.data.choices[0].message.content);
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testDeepSeek();
