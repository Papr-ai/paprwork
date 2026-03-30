# Proxy Backend Example

## Minimal Cloudflare Worker for Paprwork API Proxy

### 1. Create Cloudflare Worker

```typescript
// src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Only allow POST to /v1/chat
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat') {
      return new Response('Not found', { status: 404 });
    }

    // 1. Authenticate user (simple API key check)
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const userApiKey = authHeader.replace('Bearer ', '');
    
    // 2. Validate API key (check against KV store or database)
    const user = await env.USERS.get(userApiKey, { type: 'json' });
    if (!user) {
      return new Response('Invalid API key', { status: 401 });
    }

    // 3. Check quota
    const quotaKey = `quota:${user.id}:${new Date().toISOString().split('T')[0]}`;
    const usage = parseInt(await env.USAGE.get(quotaKey) || '0');
    
    if (usage >= user.dailyLimit) {
      return new Response('Daily quota exceeded', { status: 429 });
    }

    // 4. Parse request
    const body = await request.json();

    // 5. Forward to OpenAI with YOUR key
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,  // Your secret key
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        stream: body.stream || false,
      }),
    });

    if (!openaiResponse.ok) {
      return new Response('OpenAI API error', { status: openaiResponse.status });
    }

    // 6. Track usage
    await env.USAGE.put(quotaKey, String(usage + 1), {
      expirationTtl: 86400, // 24 hours
    });

    // 7. Log for billing
    await env.LOGS.put(`log:${Date.now()}:${user.id}`, JSON.stringify({
      userId: user.id,
      model: body.model,
      timestamp: new Date().toISOString(),
      // You'd calculate cost based on response tokens
    }));

    // 8. Return response
    return new Response(openaiResponse.body, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};

interface Env {
  OPENAI_API_KEY: string;  // Your OpenAI key (stored in Cloudflare secrets)
  USERS: KVNamespace;      // User API keys → user info
  USAGE: KVNamespace;      // Rate limiting data
  LOGS: KVNamespace;       // Usage logs for billing
}
```

### 2. Configure Secrets

```bash
# Add your OpenAI key as a secret
wrangler secret put OPENAI_API_KEY

# Create KV namespaces
wrangler kv:namespace create USERS
wrangler kv:namespace create USAGE
wrangler kv:namespace create LOGS
```

### 3. Add User API Keys

```bash
# Create a user API key
wrangler kv:key put --namespace-id=<USERS_ID> \
  "pk_live_abc123" \
  '{"id":"user_001","email":"user@example.com","dailyLimit":100}'
```

### 4. Update Paprwork App

```typescript
// In Paprwork, use proxy instead of direct OpenAI
const PROXY_URL = 'https://api.paprwork.com';  // Your Cloudflare Worker URL

async function chatCompletion(messages: CoreMessage[]) {
  const userApiKey = await getProxyApiKey();  // User gets this from paprwork.com
  
  const response = await fetch(`${PROXY_URL}/v1/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${userApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Proxy error: ${response.status}`);
  }

  return response.body;  // Stream response
}
```

### 5. Pricing Model Examples

**Option A: Free Tier + Pay-as-you-go**
```typescript
const pricing = {
  free: {
    requests: 100,       // 100 requests/day
    credits: 0,          // No credits
    models: ['gpt-3.5'], // Limited models
  },
  paid: {
    requests: 1000,      // 1000 requests/day
    credits: 10,         // $10/month credits
    models: ['gpt-3.5', 'gpt-4', 'gpt-5.2'], // All models
  },
};
```

**Option B: Credit-based**
```typescript
// User buys credits upfront ($10 = 10 credits)
// Each request costs credits based on tokens used
const cost = (inputTokens * 0.01) + (outputTokens * 0.03);  // per 1k tokens
```

## Cost Analysis

**Your costs (running proxy):**
- Cloudflare Worker: $5/mo (10M requests)
- KV storage: $0.50/GB/mo (user data + logs)
- OpenAI API: Pass-through cost (user pays via credits)

**Example: 100 users, 10 requests/day each:**
- 100 users × 10 req/day × 30 days = 30,000 requests/month
- Cloudflare cost: $0 (under free tier)
- Your profit: Markup on OpenAI costs (e.g., 20-50%)

**Pricing example:**
- OpenAI charges: $0.01/1k input tokens
- You charge users: $0.012/1k tokens (20% markup)
- Revenue: $0.002/1k tokens

## Security Considerations

1. **Rate limiting:** Prevent abuse (100 req/hour per key)
2. **API key rotation:** Allow users to regenerate keys
3. **Usage monitoring:** Alert on suspicious patterns
4. **Cost limits:** Auto-disable keys exceeding budget
5. **Audit logs:** Track all requests for debugging

## Alternative: Supabase Edge Functions

If you prefer Supabase:

```typescript
// supabase/functions/chat-proxy/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (req) => {
  const { messages, model } = await req.json()
  
  // Check Supabase auth
  const authHeader = req.headers.get('Authorization')!
  const supabase = createClient(...)
  const { data: { user } } = await supabase.auth.getUser(authHeader)
  
  if (!user) return new Response('Unauthorized', { status: 401 })
  
  // Forward to OpenAI
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages, model }),
  })
  
  return new Response(response.body)
})
```

Deploy:
```bash
supabase functions deploy chat-proxy --no-verify-jwt
```

## Summary

**Proxy backend lets you:**
- ✅ Keep API keys secret
- ✅ Control costs with quotas
- ✅ Monetize with markups or subscriptions
- ✅ Track usage per user
- ✅ Rate limit to prevent abuse

**Trade-offs:**
- ❌ Need to build/maintain backend
- ❌ Monthly hosting costs ($5-20)
- ❌ Single point of failure (if backend is down, app is down)
- ❌ More complexity vs. user API keys

For Paprwork, I'd recommend:
1. Keep current approach (OAuth + user keys) for now
2. Add proxy as optional "Paprwork Credits" feature later
3. Use Cloudflare Workers (cheapest, easiest)
