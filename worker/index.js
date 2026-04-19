// Cloudflare Worker — Torill Webinar Registration Handler
// form → D1 backup → GoHighLevel API → Meta CAPI

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
      const data = await request.json();

      if (!data.email || !data.first_name) {
        return jsonResponse({ error: 'first_name and email are required' }, 400);
      }

      const leadId   = crypto.randomUUID();
      const timestamp = data.timestamp || new Date().toISOString();

      // Step 1: Save to D1 (always, as backup)
      await saveToD1(env.DB, { id: leadId, ...data, created_at: timestamp });

      // Step 2 & 3: CRM + Meta CAPI in parallel
      const [crmResult, capiResult] = await Promise.allSettled([
        pushToGHL(env, data),
        fireMetaCAPI(env, data, request),
      ]);

      if (crmResult.status === 'rejected')  console.error('GHL push failed:', crmResult.reason);
      if (capiResult.status === 'rejected') console.error('Meta CAPI failed:', capiResult.reason);

      return jsonResponse({
        success: true,
        lead_id:    leadId,
        crm_status:  crmResult.status  === 'fulfilled' ? 'ok' : 'failed',
        capi_status: capiResult.status === 'fulfilled' ? 'ok' : 'failed',
      });

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

// ── D1 Database ──────────────────────────────────────────────
// Create table once:
//   wrangler d1 execute torill-leads --command "
//     CREATE TABLE IF NOT EXISTS leads (
//       id TEXT PRIMARY KEY,
//       first_name TEXT NOT NULL,
//       email TEXT NOT NULL,
//       phone TEXT,
//       utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
//       utm_content TEXT, utm_term TEXT,
//       fbclid TEXT, fbc TEXT, fbp TEXT,
//       page_url TEXT,
//       created_at TEXT NOT NULL
//     );"

async function saveToD1(db, data) {
  await db.prepare(`
    INSERT INTO leads
      (id, first_name, email, phone,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       fbclid, fbc, fbp, page_url, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    data.id,
    data.first_name,
    data.email,
    data.phone        || '',
    data.utm_source   || '',
    data.utm_medium   || '',
    data.utm_campaign || '',
    data.utm_content  || '',
    data.utm_term     || '',
    data.fbclid       || '',
    data.fbc          || '',
    data.fbp          || '',
    data.page_url     || '',
    data.created_at,
  ).run();
}

// ── GoHighLevel API ───────────────────────────────────────────
// Secrets needed:
//   wrangler secret put GHL_API_KEY
//   wrangler secret put GHL_LOCATION_ID
//   wrangler secret put GHL_WORKFLOW_ID

async function pushToGHL(env, data) {
  if (!env.GHL_API_KEY) {
    console.warn('GHL_API_KEY not set — skipping CRM push');
    return;
  }

  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GHL_API_KEY}`,
      'Content-Type':  'application/json',
      'Version':       '2021-07-28',
    },
    body: JSON.stringify({
      locationId:   env.GHL_LOCATION_ID,
      firstName:    data.first_name,
      email:        data.email,
      phone:        data.phone || '',
      source:       'webinar_landing_page',
      tags:         ['webinar-lead', 'torill-paanigjen-apr2026'],
      customFields: [
        { key: 'utm_source',   value: data.utm_source   || '' },
        { key: 'utm_medium',   value: data.utm_medium   || '' },
        { key: 'utm_campaign', value: data.utm_campaign || '' },
        { key: 'utm_content',  value: data.utm_content  || '' },
      ],
    }),
  });

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    throw new Error(`GHL upsert error: ${upsertRes.status} — ${errText}`);
  }

  const result    = await upsertRes.json();
  const contactId = result?.contact?.id;
  console.log(`GHL contact ${result?.new ? 'created' : 'updated'}: ${contactId}`);

  // Enroll into workflow
  if (env.GHL_WORKFLOW_ID && contactId) {
    const wfRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${env.GHL_WORKFLOW_ID}`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.GHL_API_KEY}`,
          'Version':       '2021-07-28',
        },
      }
    );
    if (!wfRes.ok) console.warn('GHL workflow trigger failed:', await wfRes.text());
  }

  return result;
}

// ── Meta Conversions API ──────────────────────────────────────
// Secrets needed:
//   wrangler secret put META_ACCESS_TOKEN
//   wrangler secret put META_PIXEL_ID
//   wrangler secret put META_TEST_EVENT_CODE   ← remove after go-live

async function fireMetaCAPI(env, data, request) {
  if (!env.META_ACCESS_TOKEN || !env.META_PIXEL_ID) {
    console.warn('Meta CAPI not configured — skipping');
    return;
  }

  const eventTime       = Math.floor(Date.now() / 1000);
  const hashedEmail     = await sha256(data.email.toLowerCase().trim());
  const hashedPhone     = data.phone ? await sha256(data.phone.replace(/\D/g, '')) : undefined;
  const hashedFirstName = await sha256(data.first_name.toLowerCase().trim());

  const payload = {
    data: [{
      event_name:       'Lead',
      event_time:       eventTime,
      event_id:         `lead_${data.email}_${eventTime}`,
      event_source_url: data.page_url || '',
      action_source:    'website',
      user_data: {
        em: [hashedEmail],
        fn: [hashedFirstName],
        ...(hashedPhone && { ph: [hashedPhone] }),
        ...(data.fbc    && { fbc: data.fbc }),
        ...(data.fbp    && { fbp: data.fbp }),
        client_ip_address: request.headers.get('CF-Connecting-IP') || '',
        client_user_agent: request.headers.get('User-Agent')       || '',
      },
    }],
  };

  if (env.META_TEST_EVENT_CODE) {
    payload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Meta CAPI error: ${res.status} — ${errText}`);
  }

  return await res.json();
}

// ── Utilities ─────────────────────────────────────────────────
async function sha256(message) {
  const msgBuffer  = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
