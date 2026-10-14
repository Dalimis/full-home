(() => {
  const API = '/api/public/investors';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));

  const text = (selector, value) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = value || '';
  };

  const setRow = (field, value) => {
    const row = document.querySelector(`[data-cms-row="${field}"]`);
    if (!row) return;
    if (value === null || value === undefined || String(value).trim() === '') {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    const cell = row.querySelector('[data-cms-value]');
    if (cell) cell.textContent = value;
  };

  const companyFooter = (c) => {
    document.querySelectorAll('[data-cms-footer-company]').forEach((el) => {
      el.textContent = c.company_name || '馥鴻建設股份有限公司';
    });
    document.querySelectorAll('[data-cms-footer-contact]').forEach((el) => {
      const parts = [c.address, c.phone].filter(Boolean);
      el.textContent = parts.join('｜');
    });
  };

  const renderCompany = (c) => {
    const fields = [
      'stock_code','company_name','company_name_en','phone','address','chairman','general_manager',
      'spokesperson','deputy_spokesperson','transfer_agent','transfer_agent_phone','transfer_agent_address'
    ];
    fields.forEach((f) => setRow(f, c[f]));
  };

  const renderContact = (c) => {
    const groups = [
      ['spokesperson','spokesperson_title','spokesperson_phone','spokesperson_email'],
      ['deputy_spokesperson','deputy_spokesperson_title','deputy_spokesperson_phone','deputy_spokesperson_email']
    ];
    groups.flat().forEach((f) => setRow(f, c[f]));
  };

  const boardDisplay = (m) => m.title || m.representative || m.note || '';

  const renderGovernance = (board) => {
    const directors = board.filter((m) => m.member_type === '董事');
    const independents = board.filter((m) => m.member_type === '獨立董事');
    const render = (selector, rows) => {
      const el = document.querySelector(selector);
      if (!el) return;
      if (!rows.length) {
        el.innerHTML = '<p class="cms-empty">目前尚無公開資料。</p>';
        return;
      }
      el.innerHTML = rows.map((m) => `
        <div class="member"><strong>${esc(m.name)}</strong><span>${esc(boardDisplay(m))}</span></div>
      `).join('');
    };
    render('#cms-directors', directors);
    render('#cms-independent-directors', independents);
  };

  const renderHomeBoard = (board) => {
    const el = document.querySelector('.board-grid[data-cms-board]');
    if (!el) return;
    if (!board.length) {
      el.innerHTML = '<p class="cms-empty">目前尚無公開董事資料。</p>';
      return;
    }
    el.innerHTML = board.map((m) => `
      <div class="board-person">
        <small>${esc(m.member_type)}</small>
        <strong>${esc(m.name)}</strong>
        <span>${esc(boardDisplay(m))}</span>
      </div>
    `).join('');
  };

  // 首頁投資人卡片：依分類顯示後台最新一份文件（<span data-cms-latest="分類A,分類B">）
  const renderHomeLatest = (docs) => {
    document.querySelectorAll('[data-cms-latest]').forEach((el) => {
      const cats = el.dataset.cmsLatest.split(',').map((c) => c.trim()).filter(Boolean);
      const latest = docs
        .filter((d) => cats.includes(d.category) && d.file_url)
        .sort((x, y) => String(y.published_at || '').localeCompare(String(x.published_at || '')))[0];
      // 後台沒有該分類文件時，保留 HTML 內原本的備援連結
      if (latest) {
        el.innerHTML = `<a href="${esc(latest.file_url)}" target="_blank" rel="noopener">最新：${esc(latest.title)} →</a>`;
      }
    });
  };

  const docLink = (d) => d.file_url ? `<a class="cms-doc-link" href="${esc(d.file_url)}" target="_blank" rel="noopener">查看文件 →</a>` : '';
  const docMeta = (d) => [d.year, d.quarter].filter(Boolean).join(' · ');

  const renderDocs = (selector, docs, categories) => {
    const el = document.querySelector(selector);
    if (!el) return;
    const filtered = docs.filter((d) => categories.includes(d.category));
    if (!filtered.length) {
      el.innerHTML = '<div class="cms-empty">目前尚無後台發布的公開文件。</div>';
      return;
    }
    el.innerHTML = filtered.map((d) => `
      <article class="cms-doc">
        <div class="cms-doc-meta">${esc(d.subcategory || d.category)}${docMeta(d) ? ' · ' + esc(docMeta(d)) : ''}</div>
        <strong>${esc(d.title)}</strong>
        ${d.description ? `<p>${esc(d.description)}</p>` : ''}
        ${docLink(d)}
      </article>
    `).join('');
  };

  const renderStock = (c) => {
    setRow('stock_code', c.stock_code);
    setRow('transfer_agent', c.transfer_agent);
    setRow('transfer_agent_address', c.transfer_agent_address);
    setRow('transfer_agent_phone', c.transfer_agent_phone);
  };

  async function init() {
    try {
      const response = await fetch(API, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`CMS API ${response.status}`);
      const data = await response.json();
      if (!data || data.ok === false) throw new Error(data?.message || 'CMS API error');

      const company = data.company || {};
      const board = Array.isArray(data.board) ? data.board : [];
      const documents = Array.isArray(data.documents) ? data.documents : [];
      const page = document.body.dataset.cmsPage || '';

      companyFooter(company);

      if (page === 'company') renderCompany(company);
      if (page === 'contact') renderContact(company);
      if (page === 'governance') {
        renderGovernance(board);
        renderDocs('#cms-governance-docs', documents, ['公司治理']);
      }
      if (page === 'shareholders') renderDocs('#cms-shareholder-docs', documents, ['股東會']);
      if (page === 'financial') renderDocs('#cms-financial-docs', documents, ['財務資訊', '法說會']);
      if (page === 'sustainability') renderDocs('#cms-sustainability-docs', documents, ['永續發展']);
      if (page === 'stock') renderStock(company);
      if (page === 'home') {
        renderHomeBoard(board);
        renderHomeLatest(documents);
      }

      document.documentElement.dataset.cmsReady = 'true';
    } catch (err) {
      console.error('Fullhome investor CMS sync failed:', err);
      document.documentElement.dataset.cmsReady = 'false';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
