// /api/bitrix-lead.js
export const config = { runtime: 'edge' };

const WEBHOOK = process.env.BITRIX_WEBHOOK_URL; // https://<портал>.bitrix24.ru/rest/<user>/<token>/

function json(res, status = 200) {
  return new Response(JSON.stringify(res, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Универсальный вызов Bitrix24
async function bxCall(method, params = {}) {
  const url = `${WEBHOOK}${method}.json`;
  const body = JSON.stringify(params);
  console.log(`[BX] call -> ${method} ${body}`);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    console.error(`[BX] ERROR <- ${method}`, r.status, data);
    throw new Error(data?.error_description || data?.error || `Bitrix call failed: ${method}`);
  }
  console.log(`[BX] ok <- ${method}`);
  return data.result;
}

// Простейшая нормализация телефона
function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[^\d+]/g, '');
  if (/^8\d{10}$/.test(p)) p = `+7${p.slice(1)}`;
  if (/^7\d{10}$/.test(p)) p = `+${p}`;
  if (!p.startsWith('+')) p = `+${p}`;
  return p;
}

// 1) Ищем контакт по телефону, иначе создаём
async function findOrCreateContact(name, phone) {
  const normPhone = normalizePhone(phone);
  console.log(`[CONTACT] search by phone: ${normPhone}`);

  const list = await bxCall('crm.contact.list', {
    filter: { PHONE: normPhone },
    select: ['ID', 'NAME'],
  });

  if (Array.isArray(list) && list.length > 0) {
    const id = list[0].ID;
    console.log(`[CONTACT] found ID: ${id}`);
    return id;
  }

  console.log('[CONTACT] not found, create new');
  const contactId = await bxCall('crm.contact.add', {
    fields: {
      NAME: name || '',
      PHONE: [{ VALUE: normPhone, VALUE_TYPE: 'WORK' }],
    },
    params: { REGISTER_SONET_EVENT: 'Y' },
  });

  console.log(`[CONTACT] created ID: ${contactId}`);
  return contactId;
}

// ключи = названия ответов, которые ты шлёшь с фронта (answers)
// значения = реальные XML_ID полей сделки из crm.deal.fields
const FIELD_MAP = {
  sposob_svyazi: 'UF_CRM_6898FF0473B14', // sposob_svyazi
  forma:         'UF_CRM_689900229E0B9', // forma
  style:         'UF_CRM_68990022A982B', // style
  razmer:        'UF_CRM_68990022B3119', // razmer
  sroki:         'UF_CRM_68990022BC2D5', // sroki
  budget:        'UF_CRM_68990022C5E9D', // budget
  podarok:       'UF_CRM_68990022D2C13', // podarok
  // если понадобится — можно добавить и эти поля:
  // zvonok:     'UF_CRM_6898FF047FAB7',
  // tranid:     'UF_CRM_6898FF048A574',
  // formname:   'UF_CRM_6898FF04936DC',
};

// 3) Собираем объект UF_* для сделки
function buildUFFields(answers = {}) {
  const uf = {};
  const entries = Object.entries(answers || {});
  console.log('[UF_MAP] incoming answers keys:', entries.map(([k]) => k));

  for (const [key, value] of entries) {
    const xml = FIELD_MAP[key];
    if (!xml) {
      console.warn(`[UF_MAP] no match for key "${key}" — пропущено`);
      continue;
    }
    uf[xml] = value;
    console.log(`[UF_MAP] mapped ${key} -> ${xml} = "${value}"`);
  }

  console.log('[UF_MAP] result fields:', uf);
  return uf;
}

// 4) Создаём сделку
async function createDeal({ title, contactId, answers }) {
  const uf = buildUFFields(answers);
  const fields = {
    TITLE: title,
    CONTACT_ID: contactId,
    ASSIGNED_BY_ID: 11,
    ...uf,
  };

  console.log('[DEAL] create fields:', fields);

  const dealId = await bxCall('crm.deal.add', {
    fields,
    params: { REGISTER_SONET_EVENT: 'Y' },
  });

  console.log(`[DEAL] created ID: ${dealId}`);

  // Доп.лог: читаем сделку обратно и печатаем только UF_*
  try {
    const deal = await bxCall('crm.deal.get', { id: dealId });
    const onlyUF = Object.fromEntries(
      Object.entries(deal || {}).filter(([k]) => k.startsWith('UF_CRM_'))
    );
    console.log('[DEAL] read-back UF_*:', onlyUF);
  } catch (e) {
    console.warn('[DEAL] read-back failed:', e?.message);
  }

  return dealId;
}

// ----------------- Handler -----------------
export default async function handler(req) {
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    if (!WEBHOOK) {
      console.error('BITRIX_WEBHOOK_URL is not set');
      return json({ ok: false, error: 'Server misconfigured: no webhook' }, 500);
    }

    const payload = await req.json();
    console.log('incoming payload:', payload);

    const name    = (payload?.name || '').toString().trim() || 'Без имени';
    const phone   = (payload?.phone || '').toString().trim();
    const answers = payload?.answers || {};

    if (!phone) return json({ ok: false, error: 'Phone is required' }, 400);

    const contactId = await findOrCreateContact(name, phone);
    const dealId    = await createDeal({
      title: `Заявка с VK - ${name} - ${normalizePhone(phone)} - ${new Date().toLocaleString('ru-RU')}`,
      contactId,
      answers,
    });

    return json({ ok: true, contactId, dealId });
  } catch (e) {
    console.error('bitrix-lead error:', e);
    return json({ ok: false, error: e?.message || 'Unknown error' }, 500);
  }
}
