// /api/bitrix-lead.js  — создаёт СДЕЛКУ. Поддерживает XML_ID полей (sposob_svyazi, forma, ...)

let UF_MAP_CACHE = null; // кэш соответствий XML_ID -> FIELD_NAME (UF_CRM_...) для CRM_DEAL

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const ROOT = process.env.BITRIX_WEBHOOK_URL; // https://.../rest/USER/TOKEN
    if (!ROOT) return res.status(500).json({ ok: false, error: 'BITRIX_WEBHOOK_URL not set' });

    // ---- helpers ------------------------------------------------------------
    const call = async (method, payload) => {
      const r = await fetch(`${ROOT}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.error || j.error_description) throw new Error(j.error_description || j.error);
      return j.result;
    };

    const getUFMapForDeals = async () => {
      if (UF_MAP_CACHE) return UF_MAP_CACHE; // warm cache внутри одного инстанса
      const r = await call('crm.userfield.list', {
        filter: { ENTITY_ID: 'CRM_DEAL' },
        select: ['FIELD_NAME', 'XML_ID'],
      });
      const map = {};
      for (const f of r) {
        if (f.XML_ID) map[f.XML_ID] = f.FIELD_NAME; // xml_id -> UF_CRM_...
      }
      UF_MAP_CACHE = map;
      return map;
    };

    const normPhone = (raw) => {
      if (!raw) return '';
      let v = String(raw).trim();
      const plus = v.startsWith('+');
      v = (plus ? '+' : '') + v.replace(/[^\d]/g, '');
      if (v.startsWith('00')) v = '+' + v.slice(2);
      let d = v.replace(/\D/g, '');
      if (!plus && d.length === 11 && d[0] === '8') { d = '7' + d.slice(1); v = '+' + d; }
      if (!v.startsWith('+')) v = '+' + d;
      return v;
    };

    const pushLine = (arr, k, v) => { if (v != null && String(v).trim() !== '') arr.push(`${k}: ${v}`); };

    // ---- body ---------------------------------------------------------------
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { answers = {}, vk_user_id = null, utm = {} } = body;

    // телефон / имя
    const PHONE = normPhone(answers.phone || answers.phone_e164 || answers['Телефон'] || '');
    const NAME  = answers.name || '';

    // сводка в комментарии
    const lines = [];
    pushLine(lines, 'Стиль',      answers.style);
    pushLine(lines, 'Планировка', answers.layout);
    pushLine(lines, 'Площадь',    answers.area);
    pushLine(lines, 'Срок',       answers.deadline);
    pushLine(lines, 'Бюджет',     answers.budget);
    pushLine(lines, 'Подарок',    answers.gift);
    pushLine(lines, 'Способ связи', answers.method);
    pushLine(lines, 'Имя',        NAME);
    pushLine(lines, 'Телефон',    PHONE);
    if (vk_user_id)     pushLine(lines, 'VK user id', vk_user_id);
    if (utm.utm_source) pushLine(lines, 'UTM source', utm.utm_source);
    if (utm.utm_campaign) pushLine(lines, 'UTM campaign', utm.utm_campaign);

    // ---- маппинг XML_ID -> UF_CRM_* ----------------------------------------
    // ожидаем, что в answers ключи типа sposob_svyazi, forma, style, razmer, sroki, budget, podarok, vopros и т.д.
    const UF_MAP = await getUFMapForDeals();
    const ufFields = {};
    for (const [key, val] of Object.entries(answers)) {
      if (val == null || String(val).trim() === '') continue;
      const uf = UF_MAP[key]; // найдём UF-поле по XML_ID
      if (uf) ufFields[uf] = val; // строковые поля заполняются как есть
      // Если какие-то UF-поля — списки (ENUM), сюда можно добавить преобразование текст->ID.
    }

    // ---- создаём/привязываем контакт (необязательно, но удобно) ------------
    let contactId = null;
    if (NAME || PHONE) {
      try {
        const contactFields = {
          NAME: NAME || 'Клиент',
          PHONE: PHONE ? [{ VALUE: PHONE, VALUE_TYPE: 'WORK' }] : [],
        };
        contactId = await call('crm.contact.add', { fields: contactFields });
      } catch (e) {
        // не критично — просто не привяжем контакт
        console.warn('create contact failed:', e.message || e);
      }
    }

    // ---- создаём СДЕЛКУ -----------------------------------------------------
    const dealFields = {
      TITLE: `Сделка VK: ${NAME || 'Клиент'}`,
      COMMENTS: lines.join('\n'),
      ASSIGNED_BY_ID: process.env.BITRIX_ASSIGNED_ID || undefined,
      CATEGORY_ID: (process.env.BITRIX_CATEGORY_ID != null ? Number(process.env.BITRIX_CATEGORY_ID) : undefined),
      STAGE_ID: process.env.BITRIX_STAGE_ID || undefined,
      CONTACT_ID: contactId || undefined,
      SOURCE_ID: 'WEB',
      ...ufFields, // наши пользовательские поля по XML_ID
    };

    const dealId = await call('crm.deal.add', { fields: dealFields });

    return res.status(200).json({ ok: true, dealId, contactId: contactId || null });
  } catch (e) {
    console.error('bitrix-deal error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
