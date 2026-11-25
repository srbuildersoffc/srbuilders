(function() {
  'use strict';

  // ── Helpers ──
  var API_BASE = window.location.origin;

  var rupee = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  });

  function formatCurrency(n) {
    return rupee.format(n || 0);
  }

  function formatDateDisplay(dateStr) {
    if (!dateStr) return '--';
    var parts = dateStr.split('T')[0].split('-');
    if (parts.length !== 3) return dateStr;
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  // ── Image Compression & Photo Helpers ──
  var currentAsstPhoto = null;
  var currentOwnerPhoto = null;
  var currentEditPhoto = null;

  function compressImage(file, maxWidth, maxHeight, quality) {
    maxWidth = maxWidth || 1920;
    maxHeight = maxHeight || 1920;
    quality = quality !== undefined ? quality : 0.78;

    if (!file || !file.type.startsWith('image/')) {
      return Promise.reject(new Error('Please select an image file'));
    }

    function drawAndExport(source, srcWidth, srcHeight, cleanup) {
      var width = srcWidth;
      var height = srcHeight;
      if (width > maxWidth || height > maxHeight) {
        if (width / height > maxWidth / maxHeight) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        } else {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, width, height);
      if (cleanup) cleanup();

      var compressedDataUri = canvas.toDataURL('image/jpeg', quality);
      var head = 'data:image/jpeg;base64,';
      var base64Length = compressedDataUri.length - head.length;
      var compressedSize = Math.round((base64Length * 3) / 4);

      return {
        data: compressedDataUri,
        type: 'image/jpeg',
        originalName: file.name,
        originalSize: file.size,
        compressedSize: compressedSize,
        width: width,
        height: height
      };
    }

    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).then(function(bitmap) {
        return drawAndExport(bitmap, bitmap.width, bitmap.height, function() {
          if (typeof bitmap.close === 'function') bitmap.close();
        });
      });
    }

    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function() { reject(new Error('Failed to read image file')); };
      reader.onload = function(e) {
        var img = new Image();
        img.onerror = function() { reject(new Error('Failed to parse image data')); };
        img.onload = function() {
          resolve(drawAndExport(img, img.width, img.height));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function openReceiptModal(url, desc) {
    if (!url) return;
    var img = document.getElementById('vr-modal-img');
    var link = document.getElementById('vr-modal-link');
    var descEl = document.getElementById('vr-modal-desc');
    var urlInput = document.getElementById('vr-url-input');

    img.src = url;
    link.href = url;
    descEl.textContent = desc || 'Expense Receipt';
    if (urlInput) urlInput.value = url;
    openModal('modal-view-receipt');
  }

  // Copy Receipt URL button in modal
  var vrCopyBtn = document.getElementById('vr-btn-copy-url');
  if (vrCopyBtn) {
    vrCopyBtn.addEventListener('click', function() {
      var urlInput = document.getElementById('vr-url-input');
      if (urlInput && urlInput.value) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(urlInput.value).then(function() {
            showToast('Receipt URL copied to clipboard!', 'success');
          }).catch(function() {
            urlInput.select();
            document.execCommand('copy');
            showToast('Receipt URL copied to clipboard!', 'success');
          });
        } else {
          urlInput.select();
          document.execCommand('copy');
          showToast('Receipt URL copied to clipboard!', 'success');
        }
      }
    });
  }

  async function handlePhotoSelection(file, previewWrapId, previewImgId, previewNameId, previewSizeId) {
    try {
      showToast('Compressing photo...', 'info');
      var res = await compressImage(file);
      document.getElementById(previewImgId).src = res.data;
      document.getElementById(previewNameId).textContent = file.name || 'Receipt Photo';
      var origKb = Math.round(res.originalSize / 1024);
      var compKb = Math.round(res.compressedSize / 1024);
      var savedPct = Math.max(0, Math.round((1 - compKb / origKb) * 100));
      document.getElementById(previewSizeId).textContent = 'Compressed: ' + compKb + ' KB' + (origKb > compKb ? ' (was ' + origKb + ' KB, ' + savedPct + '% saved)' : '');
      document.getElementById(previewWrapId).style.display = 'block';
      showToast('Photo compressed & ready', 'success');
      return res;
    } catch (err) {
      showToast('Photo error: ' + err.message, 'error');
      return null;
    }
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function getToken() { return sessionStorage.getItem('cf_token'); }
  function getRole() { return sessionStorage.getItem('cf_role'); }
  function getUsername() { return sessionStorage.getItem('cf_username'); }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken()
    };
  }

  function authHeadersNoBody() {
    return {
      'Authorization': 'Bearer ' + getToken()
    };
  }

  async function apiFetch(url, options) {
    options = options || {};
    if (!options.headers) {
      options.headers = options.body ? authHeaders() : authHeadersNoBody();
    }
    var res = await fetch(API_BASE + url, options);
    if (res.status === 401) {
      sessionStorage.clear();
      showLogin();
      throw new Error('Session expired');
    }
    return res;
  }

  // ── Toast ──
  function showToast(message, type) {
    type = type || 'success';
    var container = document.getElementById('toast-container');
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity 0.2s, transform 0.2s';
      setTimeout(function() { toast.remove(); }, 200);
    }, 3000);
  }

  // ── Modal Helpers ──
  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  document.querySelectorAll('.modal-close, .modal-cancel').forEach(function(btn) {
    btn.addEventListener('click', function() {
      btn.closest('.modal-overlay').classList.remove('open');
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(function(overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(function(m) {
        m.classList.remove('open');
      });
    }
  });

  // ── Screen Switching ──
  function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-screen').style.display = 'none';
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'block';
    document.getElementById('header-username').textContent = getUsername();
    document.getElementById('header-role').textContent = getRole();

    if (getRole() === 'owner') {
      document.getElementById('owner-view').style.display = 'block';
      document.getElementById('assistant-view').style.display = 'none';
      loadOwnerData();
    } else {
      document.getElementById('owner-view').style.display = 'none';
      document.getElementById('assistant-view').style.display = 'block';
      loadAssistantSites();
    }
  }

  // ── LOGIN ──
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');

  loginForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    loginError.style.display = 'none';
    var username = document.getElementById('login-username').value.trim();
    var password = document.getElementById('login-password').value;

    if (!username || !password) {
      loginError.textContent = 'Please enter both User ID and Password.';
      loginError.style.display = 'block';
      return;
    }

    var loginBtn = document.getElementById('login-btn');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';

    try {
      var res = await fetch(API_BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      var data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Invalid credentials');
      }
      sessionStorage.setItem('cf_token', data.token);
      sessionStorage.setItem('cf_role', data.role);
      sessionStorage.setItem('cf_username', data.username);
      showApp();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.style.display = 'block';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }
  });

  // Password toggle
  document.getElementById('pw-toggle').addEventListener('click', function() {
    var input = document.getElementById('login-password');
    var isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    this.innerHTML = isPassword
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    this.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', function() {
    sessionStorage.clear();
    showLogin();
    loginForm.reset();
    loginError.style.display = 'none';
  });

  // ── OWNER: Tab Switching ──
  var activeOwnerTab = 'tab-projects';
  var loadedExpensesSite = '';
  var loadedAdvancesSite = '';

  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      activeOwnerTab = btn.dataset.tab;
      document.getElementById(activeOwnerTab).classList.add('active');

      // Lazy-load tab data only if not already loaded for selectedSiteId
      if (selectedSiteId) {
        if (activeOwnerTab === 'tab-expenses' && loadedExpensesSite !== selectedSiteId) {
          loadExpenses(selectedSiteId);
          loadExpenseSummary(selectedSiteId);
        } else if (activeOwnerTab === 'tab-advances' && loadedAdvancesSite !== selectedSiteId) {
          loadAdvances(selectedSiteId);
        }
      }
    });
  });

  // ── Keep site selectors in sync ──
  var expenseSiteSelect = document.getElementById('expense-site-select');
  var advanceSiteSelect = document.getElementById('advance-site-select');
  var selectedSiteId = '';

  expenseSiteSelect.addEventListener('change', function() {
    selectedSiteId = this.value;
    advanceSiteSelect.value = selectedSiteId;
    loadedExpensesSite = '';
    loadedAdvancesSite = '';
    if (selectedSiteId) {
      loadExpenses(selectedSiteId);
      loadExpenseSummary(selectedSiteId);
    } else {
      clearExpensesTable();
      clearAdvancesTable();
    }
  });

  advanceSiteSelect.addEventListener('change', function() {
    selectedSiteId = this.value;
    expenseSiteSelect.value = selectedSiteId;
    loadedExpensesSite = '';
    loadedAdvancesSite = '';
    if (selectedSiteId) {
      loadAdvances(selectedSiteId);
    } else {
      clearAdvancesTable();
      clearExpensesTable();
    }
  });

  // ── OWNER: Load Data ──
  var summaryData = [];

  async function loadOwnerData() {
    await loadSummary();
  }

  async function loadSummary() {
    try {
      var res = await apiFetch('/api/sites/summary');
      summaryData = await res.json();
      renderProjectsTable(summaryData);
      renderMetrics(summaryData);
      populateOwnerSiteDropdowns(summaryData);
    } catch (err) {
      showToast('Failed to load summary: ' + err.message, 'error');
    }
  }

  function renderMetrics(data) {
    var totalAdv = 0, totalExp = 0, activeCount = 0;
    data.forEach(function(s) {
      totalAdv += Number(s.total_advance) || 0;
      totalExp += Number(s.total_expenses) || 0;
      if (s.status === 'active') activeCount++;
    });
    var balance = totalAdv - totalExp;

    document.getElementById('m-advance').textContent = formatCurrency(totalAdv);
    document.getElementById('m-expenses').textContent = formatCurrency(totalExp);

    var balEl = document.getElementById('m-balance');
    balEl.textContent = formatCurrency(balance);
    balEl.className = 'metric-value mono' + (balance >= 0 ? ' positive' : ' negative');

    document.getElementById('m-active').textContent = activeCount;
  }

  var htmlEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, function(ch) { return htmlEscapeMap[ch]; });
  }

  // Event delegation for Projects table (bound once)
  document.getElementById('projects-tbody').addEventListener('click', function(e) {
    var editBtn = e.target.closest('[data-edit-site]');
    if (editBtn) {
      openEditSiteModal(editBtn.dataset.editSite);
      return;
    }
    var delBtn = e.target.closest('[data-delete-site]');
    if (delBtn) {
      pendingDeleteType = 'site';
      pendingDeleteId = delBtn.dataset.deleteSite;
      document.getElementById('delete-modal-msg').textContent = 'Are you sure you want to permanently delete site ' + pendingDeleteId + ' and all its recorded advances and expenses? This action cannot be undone.';
      openModal('modal-confirm-delete');
    }
  });

  function renderProjectsTable(data) {
    var tbody = document.getElementById('projects-tbody');
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--secondary); padding:24px;">No sites found. Add your first site to get started.</td></tr>';
      return;
    }

    var html = '';
    data.forEach(function(s) {
      var balance = Number(s.difference) || 0;
      var totalAdv = Number(s.total_advance) || 0;
      var totalExp = Number(s.total_expenses) || 0;
      var pct = totalAdv > 0 ? Math.min(100, Math.round((totalExp / totalAdv) * 100)) : 0;

      var barColor = pct < 70 ? 'var(--success)' : pct < 90 ? 'var(--warning)' : 'var(--danger)';
      var balanceClass = balance >= 0 ? 'text-success' : 'text-danger';

      var statusClass = 'badge-active';
      var statusLabel = s.status || 'active';
      if (statusLabel === 'completed') statusClass = 'badge-completed';
      else if (statusLabel === 'on-hold' || statusLabel === 'onhold') statusClass = 'badge-onhold';

      html += '<tr>';
      html += '<td>' + escapeHtml(String(s.site_id || '--')) + '</td>';
      html += '<td style="font-weight:500;">' + escapeHtml(s.site_name || '') + '</td>';
      html += '<td>' + escapeHtml(s.client_name || '--') + '</td>';
      html += '<td><span class="badge ' + statusClass + '">' + escapeHtml(statusLabel) + '</span></td>';
      html += '<td style="text-align:right" class="mono">' + formatCurrency(totalAdv) + '</td>';
      html += '<td style="text-align:right" class="mono">' + formatCurrency(totalExp) + '</td>';
      html += '<td style="text-align:right" class="mono ' + balanceClass + '">' + formatCurrency(balance) + '</td>';
      html += '<td>';
      html += '<span class="util-bar"><span class="util-bar-fill" style="width:' + pct + '%; background:' + barColor + '"></span></span>';
      html += '<span class="util-text">' + pct + '%</span>';
      html += '</td>';
      html += '<td style="text-align:right; white-space:nowrap;">';
      html += '<button class="btn btn-outline btn-sm btn-edit-site" data-edit-site="' + escapeHtml(s.site_id) + '" style="padding:4px 8px; font-size:12px; margin-right:4px;">Edit</button>';
      html += '<button class="btn btn-danger btn-sm btn-delete-site" data-delete-site="' + escapeHtml(s.site_id) + '" style="padding:4px 8px; font-size:12px;">Delete</button>';
      html += '</td>';
      html += '</tr>';
    });
    tbody.innerHTML = html;
  }

  function populateOwnerSiteDropdowns(sites) {
    var options = '<option value="">Select a site</option>';
    sites.forEach(function(s) {
      options += '<option value="' + escapeHtml(s.site_id) + '">' + escapeHtml(s.site_name) + '</option>';
    });
    expenseSiteSelect.innerHTML = options;
    advanceSiteSelect.innerHTML = options;

    if (selectedSiteId) {
      expenseSiteSelect.value = selectedSiteId;
      advanceSiteSelect.value = selectedSiteId;
    }
  }

  // ── OWNER: Expenses ──
  function clearExpensesTable() {
    document.getElementById('expenses-table').style.display = 'none';
    document.getElementById('expense-summary').style.display = 'none';
  }

  function loadExpenseSummary(siteId) {
    var site = summaryData.find(function(s) { return String(s.site_id) === String(siteId); });
    if (site) {
      document.getElementById('expense-summary').style.display = 'flex';
      var adv = Number(site.total_advance) || 0;
      var exp = Number(site.total_expenses) || 0;
      var rem = adv - exp;
      document.getElementById('es-advance').textContent = formatCurrency(adv);
      document.getElementById('es-spent').textContent = formatCurrency(exp);
      var remEl = document.getElementById('es-remaining');
      remEl.textContent = formatCurrency(rem);
      remEl.className = 'summary-value mono' + (rem >= 0 ? ' text-success' : ' text-danger');
    }
  }

  var expenseStore = {};

  function openEditExpenseModal(expense, siteId) {
    document.getElementById('ee-id').value = expense.id;
    document.getElementById('ee-site-id').value = siteId || expense.site_id || '';
    var dateStr = '';
    if (expense.expense_date) {
      dateStr = String(expense.expense_date).slice(0, 10);
    }
    document.getElementById('ee-date').value = dateStr;
    document.getElementById('ee-desc').value = expense.description || '';
    document.getElementById('ee-amount').value = expense.amount || '';

    // Initialize photo preview in edit modal
    currentEditPhoto = null;
    document.getElementById('ee-camera-input').value = '';
    document.getElementById('ee-gallery-input').value = '';
    var previewWrap = document.getElementById('ee-photo-preview');
    var urlWrap = document.getElementById('ee-receipt-url-wrap');
    var urlLink = document.getElementById('ee-receipt-url-link');
    if (expense.receipt_url) {
      document.getElementById('ee-preview-img').src = expense.receipt_url;
      document.getElementById('ee-preview-name').textContent = 'Existing Receipt';
      document.getElementById('ee-preview-size').textContent = 'Saved in Google Drive';
      previewWrap.style.display = 'block';
      if (urlWrap && urlLink) {
        urlLink.href = expense.receipt_url;
        urlLink.textContent = expense.receipt_url;
        urlWrap.style.display = 'block';
      }
    } else {
      previewWrap.style.display = 'none';
      if (urlWrap) urlWrap.style.display = 'none';
    }

    openModal('modal-edit-expense');
  }

  // Delegated click handler bound once per expense/advance tbody
  function bindExpenseTableDelegation(tbodyId, getSiteId) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.addEventListener('click', function(e) {
      var receiptLink = e.target.closest('.btn-view-receipt');
      if (receiptLink) {
        e.preventDefault();
        e.stopPropagation();
        openReceiptModal(receiptLink.dataset.url, receiptLink.dataset.desc);
        return;
      }
      var editBtn = e.target.closest('[data-edit-expense]');
      if (editBtn) {
        var ex = expenseStore[editBtn.dataset.editExpense];
        if (ex) openEditExpenseModal(ex, getSiteId());
        return;
      }
      var delBtn = e.target.closest('[data-delete-expense]');
      if (delBtn) {
        pendingDeleteType = 'expense';
        pendingDeleteId = delBtn.dataset.deleteExpense;
        document.getElementById('delete-modal-msg').textContent = 'Are you sure you want to delete this expense? This action cannot be undone.';
        openModal('modal-confirm-delete');
      }
    });
  }

  bindExpenseTableDelegation('expenses-tbody', function() { return selectedSiteId; });
  bindExpenseTableDelegation('asst-today-tbody', function() { return asstSelectedSiteId || asstSiteSelect.value; });
  bindExpenseTableDelegation('asst-expenses-tbody', function() { return asstSelectedSiteId || asstSiteSelect.value; });

  document.getElementById('advances-tbody').addEventListener('click', function(e) {
    var delBtn = e.target.closest('[data-delete-advance]');
    if (delBtn) {
      pendingDeleteType = 'advance';
      pendingDeleteId = delBtn.dataset.deleteAdvance;
      openModal('modal-confirm-delete');
    }
  });

  async function loadExpenses(siteId) {
    try {
      var res = await apiFetch('/api/sites/' + siteId + '/expenses');
      var expenses = await res.json();
      loadedExpensesSite = siteId;
      document.getElementById('expenses-table').style.display = 'table';

      var tbody = document.getElementById('expenses-tbody');
      if (expenses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--secondary); padding:20px;">No expenses recorded yet.</td></tr>';
        document.getElementById('expenses-total').textContent = formatCurrency(0);
        return;
      }

      var html = '';
      var total = 0;
      expenses.forEach(function(ex) {
        expenseStore[ex.id] = ex;
        var amt = Number(ex.amount) || 0;
        total += amt;
        var receiptBtn = ex.receipt_url ? ' <a href="' + escapeHtml(ex.receipt_url) + '" target="_blank" rel="noopener noreferrer" class="btn-view-receipt receipt-pill" data-url="' + escapeHtml(ex.receipt_url) + '" data-desc="' + escapeHtml(ex.description || '') + '" title="Click to view receipt or right-click to copy link">&#128247; Receipt &#x2197;</a>' : '';
        html += '<tr>';
        html += '<td style="white-space:nowrap">' + formatDateDisplay(ex.expense_date) + '</td>';
        html += '<td>' + escapeHtml(ex.description || '') + receiptBtn + '</td>';
        html += '<td style="text-align:right" class="mono">' + formatCurrency(amt) + '</td>';
        html += '<td style="text-align:right" class="mono">' + formatCurrency(ex.cumulative_expense) + '</td>';
        html += '<td style="text-align:right; white-space:nowrap;">';
        html += '<button class="btn btn-outline btn-sm btn-edit-expense" data-edit-expense="' + ex.id + '" style="padding:4px 8px; font-size:12px; margin-right:4px;">Edit</button>';
        html += '<button class="btn btn-danger btn-sm btn-delete-expense" data-delete-expense="' + ex.id + '" style="padding:4px 8px; font-size:12px;">Delete</button>';
        html += '</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
      document.getElementById('expenses-total').textContent = formatCurrency(total);
    } catch (err) {
      showToast('Failed to load expenses: ' + err.message, 'error');
    }
  }

  // ── OWNER: Advances ──
  function clearAdvancesTable() {
    document.getElementById('advances-table').style.display = 'none';
  }

  async function loadAdvances(siteId) {
    try {
      var res = await apiFetch('/api/sites/' + siteId + '/advances');
      var advances = await res.json();
      loadedAdvancesSite = siteId;
      document.getElementById('advances-table').style.display = 'table';

      var tbody = document.getElementById('advances-tbody');
      if (advances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--secondary); padding:20px;">No advances recorded yet.</td></tr>';
        document.getElementById('advances-total').textContent = formatCurrency(0);
        return;
      }

      var html = '';
      var total = 0;
      advances.forEach(function(adv) {
        var amt = Number(adv.amount) || 0;
        total += amt;
        html += '<tr>';
        html += '<td style="white-space:nowrap">' + formatDateDisplay(adv.payment_date) + '</td>';
        html += '<td style="text-align:right" class="mono">' + formatCurrency(amt) + '</td>';
        html += '<td>' + escapeHtml(adv.notes || '--') + '</td>';
        html += '<td style="text-align:right" class="mono">' + formatCurrency(adv.cumulative_advance) + '</td>';
        html += '<td><button class="btn btn-danger" data-delete-advance="' + adv.id + '" aria-label="Delete advance">Delete</button></td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
      document.getElementById('advances-total').textContent = formatCurrency(total);
    } catch (err) {
      showToast('Failed to load advances: ' + err.message, 'error');
    }
  }

  // ── Delete Confirmation ──
  var pendingDeleteType = '';
  var pendingDeleteId = '';

  document.getElementById('confirm-delete-btn').addEventListener('click', async function() {
    if (!pendingDeleteId) return;

    var url = pendingDeleteType === 'expense'
      ? '/api/expenses/' + pendingDeleteId
      : pendingDeleteType === 'site'
      ? '/api/sites/' + pendingDeleteId
      : '/api/advances/' + pendingDeleteId;

    try {
      var res = await apiFetch(url, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      var msg = pendingDeleteType === 'expense'
        ? 'Expense deleted'
        : pendingDeleteType === 'site'
        ? 'Site and all records deleted'
        : 'Advance deleted';
      showToast(msg, 'success');
      closeModal('modal-confirm-delete');

      if (pendingDeleteType === 'site') {
        if (selectedSiteId === pendingDeleteId) {
          selectedSiteId = '';
          loadedExpensesSite = '';
          loadedAdvancesSite = '';
          clearExpensesTable();
          clearAdvancesTable();
        }
        await loadSummary();
      } else if (pendingDeleteType === 'expense') {
        if (getRole() === 'owner') {
          await Promise.all([
            selectedSiteId ? loadExpenses(selectedSiteId) : Promise.resolve(),
            loadSummary()
          ]);
          if (selectedSiteId) loadExpenseSummary(selectedSiteId);
        } else {
          var asstSite = asstSelectedSiteId || asstSiteSelect.value;
          if (asstSite) {
            await loadAssistantSiteExpenses(asstSite);
          }
        }
      } else {
        await Promise.all([
          selectedSiteId ? loadAdvances(selectedSiteId) : Promise.resolve(),
          loadSummary()
        ]);
        if (selectedSiteId) loadExpenseSummary(selectedSiteId);
      }
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }

    pendingDeleteType = '';
    pendingDeleteId = '';
  });

  // ── Edit Site Form ──
  function openEditSiteModal(siteId) {
    var site = summaryData.find(function(s) { return String(s.site_id) === String(siteId); });
    if (!site) return;
    document.getElementById('es-site-id').value = site.site_id;
    document.getElementById('es-site-name').value = site.site_name || '';
    document.getElementById('es-client-name').value = site.client_name || '';
    document.getElementById('es-site-status').value = site.status || 'active';

    var dateVal = '';
    if (site.start_date) {
      try {
        dateVal = new Date(site.start_date).toISOString().slice(0, 10);
      } catch (err) {
        dateVal = String(site.start_date).slice(0, 10);
      }
    }
    document.getElementById('es-start-date').value = dateVal;
    openModal('modal-edit-site');
  }

  document.getElementById('form-edit-site').addEventListener('submit', async function(e) {
    e.preventDefault();
    var siteId = document.getElementById('es-site-id').value;
    var siteName = document.getElementById('es-site-name').value.trim();
    var clientName = document.getElementById('es-client-name').value.trim();
    var status = document.getElementById('es-site-status').value;
    var startDate = document.getElementById('es-start-date').value;

    if (!siteName) {
      showToast('Site name is required', 'error');
      return;
    }

    try {
      var res = await apiFetch('/api/sites/' + siteId, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          site_name: siteName,
          client_name: clientName,
          status: status,
          start_date: startDate || null
        })
      });
      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || errData.error || 'Failed to update site');
      }
      showToast('Site details updated', 'success');
      closeModal('modal-edit-site');
      await loadSummary();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  // ── Edit Expense Form ──
  document.getElementById('form-edit-expense').addEventListener('submit', async function(e) {
    e.preventDefault();
    var id = document.getElementById('ee-id').value;
    var expDate = document.getElementById('ee-date').value;
    var desc = document.getElementById('ee-desc').value.trim();
    var amount = Number(document.getElementById('ee-amount').value);

    if (!expDate || !desc || !amount) {
      showToast('All fields are required', 'error');
      return;
    }

    try {
      var payload = {
        expense_date: expDate,
        description: desc,
        amount: amount
      };

      if (currentEditPhoto && currentEditPhoto.remove) {
        payload.receipt_url = null;
      } else if (currentEditPhoto && currentEditPhoto.data) {
        payload.image = { data: currentEditPhoto.data, type: currentEditPhoto.type };
        showToast('Uploading receipt to Google Drive...', 'info');
      }

      var res = await apiFetch('/api/expenses/' + id, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || errData.error || 'Failed to update expense');
      }
      showToast('Expense updated successfully', 'success');
      currentEditPhoto = null;
      closeModal('modal-edit-expense');

      if (getRole() === 'owner') {
        await Promise.all([
          selectedSiteId ? loadExpenses(selectedSiteId) : Promise.resolve(),
          loadSummary()
        ]);
        if (selectedSiteId) loadExpenseSummary(selectedSiteId);
      } else {
        var asstSite = asstSelectedSiteId || asstSiteSelect.value;
        if (asstSite) {
          await loadAssistantSiteExpenses(asstSite);
        }
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  // Edit Expense Photo Handlers
  document.getElementById('ee-btn-camera').addEventListener('click', function() {
    document.getElementById('ee-camera-input').click();
  });
  document.getElementById('ee-btn-gallery').addEventListener('click', function() {
    document.getElementById('ee-gallery-input').click();
  });
  document.getElementById('ee-camera-input').addEventListener('change', async function() {
    if (this.files && this.files[0]) {
      currentEditPhoto = await handlePhotoSelection(this.files[0], 'ee-photo-preview', 'ee-preview-img', 'ee-preview-name', 'ee-preview-size');
    }
  });
  document.getElementById('ee-gallery-input').addEventListener('change', async function() {
    if (this.files && this.files[0]) {
      currentEditPhoto = await handlePhotoSelection(this.files[0], 'ee-photo-preview', 'ee-preview-img', 'ee-preview-name', 'ee-preview-size');
    }
  });
  document.getElementById('ee-btn-remove-photo').addEventListener('click', function() {
    currentEditPhoto = { remove: true };
    document.getElementById('ee-camera-input').value = '';
    document.getElementById('ee-gallery-input').value = '';
    document.getElementById('ee-photo-preview').style.display = 'none';
  });
  document.getElementById('ee-preview-img').addEventListener('click', function() {
    if (this.src) openReceiptModal(this.src, document.getElementById('ee-desc').value);
  });

  // ── New Site Form ──
  document.getElementById('btn-new-site').addEventListener('click', function() {
    document.getElementById('form-new-site').reset();
    document.getElementById('ns-date').value = todayISO();
    openModal('modal-new-site');
  });

  document.getElementById('form-new-site').addEventListener('submit', async function(e) {
    e.preventDefault();
    var siteName = document.getElementById('ns-name').value.trim();
    var clientName = document.getElementById('ns-client').value.trim();
    var startDate = document.getElementById('ns-date').value;

    if (!siteName) {
      showToast('Site name is required', 'error');
      return;
    }

    try {
      var res = await apiFetch('/api/sites', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          site_name: siteName,
          client_name: clientName,
          start_date: startDate || null
        })
      });
      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || errData.error || 'Failed to create site');
      }
      showToast('Site created successfully', 'success');
      closeModal('modal-new-site');
      await loadSummary();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });

  // ── Add Expense Form ──
  var isSubmittingOwnerExpense = false;
  document.getElementById('btn-add-expense').addEventListener('click', function() {
    if (!selectedSiteId) {
      showToast('Please select a site first', 'error');
      return;
    }
    document.getElementById('form-add-expense').reset();
    document.getElementById('ae-date').value = todayISO();
    currentOwnerPhoto = null;
    document.getElementById('ae-camera-input').value = '';
    document.getElementById('ae-gallery-input').value = '';
    document.getElementById('ae-photo-preview').style.display = 'none';
    openModal('modal-add-expense');
  });

  document.getElementById('form-add-expense').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (isSubmittingOwnerExpense) return;

    var expDate = document.getElementById('ae-date').value;
    var desc = document.getElementById('ae-desc').value.trim();
    var amount = Number(document.getElementById('ae-amount').value);

    if (!expDate || !desc || !amount) {
      showToast('All fields are required', 'error');
      return;
    }

    var submitBtn = this.querySelector('button[type="submit"]');
    var origBtnText = submitBtn ? submitBtn.textContent : '';

    isSubmittingOwnerExpense = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = (currentOwnerPhoto && currentOwnerPhoto.data) ? 'Uploading to Drive...' : 'Saving...';
    }

    try {
      var payload = {
        expense_date: expDate,
        description: desc,
        amount: amount
      };
      if (currentOwnerPhoto && currentOwnerPhoto.data) {
        payload.image = { data: currentOwnerPhoto.data, type: currentOwnerPhoto.type };
        showToast('Uploading receipt to Google Drive...', 'info');
      }

      var res = await apiFetch('/api/sites/' + selectedSiteId + '/expenses', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || errData.error || 'Failed to add expense');
      }

      var resData = await res.json().catch(function() { return {}; });
      if (resData && resData.receipt_url) {
        showToast('Expense & Receipt saved to Google Drive!', 'success');
      } else if (payload.image) {
        showToast('Expense saved (Drive upload offline/pending)', 'warning');
      } else {
        showToast('Expense added successfully', 'success');
      }

      currentOwnerPhoto = null;
      document.getElementById('ae-camera-input').value = '';
      document.getElementById('ae-gallery-input').value = '';
      document.getElementById('ae-photo-preview').style.display = 'none';
      closeModal('modal-add-expense');
      await Promise.all([
        loadExpenses(selectedSiteId),
        loadSummary()
      ]);
      loadExpenseSummary(selectedSiteId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      isSubmittingOwnerExpense = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origBtnText;
      }
    }
  });

  // Owner Add Expense Photo Handlers
  document.getElementById('ae-btn-camera').addEventListener('click', function() {
    document.getElementById('ae-camera-input').click();
  });
  document.getElementById('ae-btn-gallery').addEventListener('click', function() {
    document.getElementById('ae-gallery-input').click();
  });
  document.getElementById('ae-camera-input').addEventListener('change', async function() {
    if (this.files && this.files[0]) {
      currentOwnerPhoto = await handlePhotoSelection(this.files[0], 'ae-photo-preview', 'ae-preview-img', 'ae-preview-name', 'ae-preview-size');
    }
  });
  document.getElementById('ae-gallery-input').addEventListener('change', async function() {
    if (this.files && this.files[0]) {
      currentOwnerPhoto = await handlePhotoSelection(this.files[0], 'ae-photo-preview', 'ae-preview-img', 'ae-preview-name', 'ae-preview-size');
    }
  });
  document.getElementById('ae-btn-remove-photo').addEventListener('click', function() {
    currentOwnerPhoto = null;
    document.getElementById('ae-camera-input').value = '';
    document.getElementById('ae-gallery-input').value = '';
    document.getElementById('ae-photo-preview').style.display = 'none';
  });
  document.getElementById('ae-preview-img').addEventListener('click', function() {
    if (this.src) openReceiptModal(this.src, document.getElementById('ae-desc').value);
  });

  // ── Add Advance Form ──
  var isSubmittingAdvance = false;
  document.getElementById('btn-add-advance').addEventListener('click', function() {
    if (!selectedSiteId) {
      showToast('Please select a site first', 'error');
      return;
    }
    document.getElementById('form-add-advance').reset();
    document.getElementById('aa-date').value = todayISO();
    openModal('modal-add-advance');
  });

  document.getElementById('form-add-advance').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (isSubmittingAdvance) return;

    var payDate = document.getElementById('aa-date').value;
    var amount = Number(document.getElementById('aa-amount').value);
    var notes = document.getElementById('aa-notes').value.trim();

    if (!payDate || !amount) {
      showToast('Date and amount are required', 'error');
      return;
    }

    var submitBtn = this.querySelector('button[type="submit"]');
    var origBtnText = submitBtn ? submitBtn.textContent : '';
    isSubmittingAdvance = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
    }

    try {
      var res = await apiFetch('/api/sites/' + selectedSiteId + '/advances', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          payment_date: payDate,
          amount: amount,
          notes: notes
        })
      });
      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || errData.error || 'Failed to add advance');
      }
      showToast('Advance added', 'success');
      closeModal('modal-add-advance');
      await Promise.all([
        loadAdvances(selectedSiteId),
        loadSummary()
      ]);
      loadExpenseSummary(selectedSiteId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      isSubmittingAdvance = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origBtnText;
      }
    }
  });

  // ── Export Buttons ──
  document.getElementById('btn-export-all').addEventListener('click', async function() {
    try {
      var res = await apiFetch('/api/export/all');
      if (!res.ok) throw new Error('Export failed');
      var blob = await res.blob();
      downloadBlob(blob, 'ContractFlow_Summary.xlsx');
      showToast('Summary exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });

  document.getElementById('btn-export-site').addEventListener('click', async function() {
    if (!selectedSiteId) {
      showToast('Please select a site first', 'error');
      return;
    }
    try {
      var res = await apiFetch('/api/sites/' + selectedSiteId + '/export');
      if (!res.ok) throw new Error('Export failed');
      var blob = await res.blob();
      downloadBlob(blob, 'Site_Ledger_' + selectedSiteId + '.xlsx');
      showToast('Ledger exported', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── ASSISTANT VIEW ──
  var asstSiteSelect = document.getElementById('asst-site-select');
  var asstLedgerSiteSelect = document.getElementById('asst-ledger-site-select');
  var asstSelectedSiteId = '';

  // Tab switching for Assistant
  document.querySelectorAll('[data-asst-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('[data-asst-tab]').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.asst-tab-panel').forEach(function(p) { p.classList.remove('active'); p.style.display = 'none'; });
      btn.classList.add('active');
      var target = document.getElementById(btn.dataset.asstTab);
      if (target) {
        target.classList.add('active');
        target.style.display = 'block';
      }
    });
  });

  document.getElementById('btn-switch-to-ledger').addEventListener('click', function() {
    var ledgerBtn = document.getElementById('asst-tab-btn-ledger');
    if (ledgerBtn) ledgerBtn.click();
  });

  document.getElementById('btn-asst-add-expense').addEventListener('click', function() {
    var entryBtn = document.getElementById('asst-tab-btn-entry');
    if (entryBtn) entryBtn.click();
  });

  async function loadAssistantSites() {
    try {
      var res = await apiFetch('/api/sites');
      var sites = await res.json();
      var options = '<option value="">Select a site</option>';
      sites.forEach(function(s) {
        options += '<option value="' + s.site_id + '">' + escapeHtml(s.site_name) + '</option>';
      });
      asstSiteSelect.innerHTML = options;
      asstLedgerSiteSelect.innerHTML = options;

      if (!asstSelectedSiteId && sites.length > 0) {
        asstSelectedSiteId = sites[0].site_id;
      }

      if (asstSelectedSiteId) {
        asstSiteSelect.value = asstSelectedSiteId;
        asstLedgerSiteSelect.value = asstSelectedSiteId;
        loadAssistantSiteExpenses(asstSelectedSiteId);
      }
    } catch (err) {
      showToast('Failed to load sites', 'error');
    }
    // Set default date
    document.getElementById('asst-date').value = todayISO();
  }

  function clearAssistantTables() {
    document.getElementById('asst-today-tbody').innerHTML =
      '<tr><td colspan="4" style="text-align:center; color:var(--secondary); padding:20px;">Select a site to view entries</td></tr>';
    document.getElementById('asst-expenses-tbody').innerHTML =
      '<tr><td colspan="5" style="text-align:center; color:var(--secondary); padding:20px;">Select a site to view expenses</td></tr>';
    document.getElementById('asst-expenses-table').style.display = 'none';
    document.getElementById('asst-expense-summary').style.display = 'none';
  }

  asstSiteSelect.addEventListener('change', function() {
    asstSelectedSiteId = this.value;
    asstLedgerSiteSelect.value = asstSelectedSiteId;
    if (asstSelectedSiteId) {
      loadAssistantSiteExpenses(asstSelectedSiteId);
    } else {
      clearAssistantTables();
    }
  });

  asstLedgerSiteSelect.addEventListener('change', function() {
    asstSelectedSiteId = this.value;
    asstSiteSelect.value = asstSelectedSiteId;
    if (asstSelectedSiteId) {
      loadAssistantSiteExpenses(asstSelectedSiteId);
    } else {
      clearAssistantTables();
    }
  });

  function renderTodayExpensesFromList(expenses) {
    var today = todayISO();
    var entries = expenses.filter(function(e) {
      return String(e.expense_date || '').slice(0, 10) === today;
    });
    var tbody = document.getElementById('asst-today-tbody');

    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--secondary); padding:20px;">No entries yet today.</td></tr>';
      return;
    }

    var html = '';
    entries.forEach(function(e) {
      var receiptBtn = e.receipt_url ? ' <a href="' + escapeHtml(e.receipt_url) + '" target="_blank" rel="noopener noreferrer" class="btn-view-receipt receipt-pill" data-url="' + escapeHtml(e.receipt_url) + '" data-desc="' + escapeHtml(e.description || '') + '" title="Click to view receipt or right-click to copy link">&#128247; Receipt &#x2197;</a>' : '';
      html += '<tr>';
      html += '<td style="white-space:nowrap">' + formatDateDisplay(e.expense_date) + '</td>';
      html += '<td>' + escapeHtml(e.description || '') + receiptBtn + '</td>';
      html += '<td style="text-align:right" class="mono">' + formatCurrency(e.amount) + '</td>';
      html += '<td style="text-align:right; white-space:nowrap;">';
      html += '<button class="btn btn-outline btn-sm btn-edit-expense" data-edit-expense="' + e.id + '" style="padding:4px 8px; font-size:12px; margin-right:4px;">Edit</button>';
      html += '<button class="btn btn-danger btn-sm btn-delete-expense" data-delete-expense="' + e.id + '" style="padding:4px 8px; font-size:12px;">Delete</button>';
      html += '</td>';
      html += '</tr>';
    });
    tbody.innerHTML = html;
  }

  async function loadAssistantSiteExpenses(siteId) {
    try {
      var res = await apiFetch('/api/sites/' + siteId + '/expenses');
      var expenses = await res.json();

      var table = document.getElementById('asst-expenses-table');
      var summary = document.getElementById('asst-expense-summary');
      table.style.display = 'table';
      summary.style.display = 'flex';

      var siteOption = asstSiteSelect.querySelector('option[value="' + siteId + '"]');
      var siteName = siteOption ? siteOption.textContent : siteId;
      document.getElementById('asst-es-name').textContent = siteName;

      var tbody = document.getElementById('asst-expenses-tbody');
      if (expenses.length === 0) {
        renderTodayExpensesFromList([]);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--secondary); padding:20px;">No expenses recorded yet for this site.</td></tr>';
        document.getElementById('asst-expenses-total').textContent = formatCurrency(0);
        document.getElementById('asst-es-total').textContent = formatCurrency(0);
        document.getElementById('asst-es-count').textContent = '0 entries';
        return;
      }

      var html = '';
      var total = 0;
      expenses.forEach(function(ex) {
        expenseStore[ex.id] = ex;
        var amt = Number(ex.amount) || 0;
        total += amt;
        var receiptBtn = ex.receipt_url ? ' <a href="' + escapeHtml(ex.receipt_url) + '" target="_blank" rel="noopener noreferrer" class="btn-view-receipt receipt-pill" data-url="' + escapeHtml(ex.receipt_url) + '" data-desc="' + escapeHtml(ex.description || '') + '" title="Click to view receipt or right-click to copy link">&#128247; Receipt &#x2197;</a>' : '';
        html += '<tr>';
        html += '<td style="white-space:nowrap">' + formatDateDisplay(ex.expense_date) + '</td>';
        html += '<td>' + escapeHtml(ex.description || '') + receiptBtn + '</td>';
        html += '<td style="text-align:right" class="mono">' + formatCurrency(amt) + '</td>';
        html += '<td style="text-align:right" class="mono">' + formatCurrency(ex.cumulative_expense) + '</td>';
        html += '<td style="text-align:right; white-space:nowrap;">';
        html += '<button class="btn btn-outline btn-sm btn-edit-expense" data-edit-expense="' + ex.id + '" style="padding:4px 8px; font-size:12px; margin-right:4px;">Edit</button>';
        html += '<button class="btn btn-danger btn-sm btn-delete-expense" data-delete-expense="' + ex.id + '" style="padding:4px 8px; font-size:12px;">Delete</button>';
        html += '</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
      document.getElementById('asst-expenses-total').textContent = formatCurrency(total);
      document.getElementById('asst-es-total').textContent = formatCurrency(total);
      document.getElementById('asst-es-count').textContent = expenses.length + ' entries';

      renderTodayExpensesFromList(expenses);
    } catch (err) {
      showToast('Failed to load site expenses: ' + err.message, 'error');
    }
  }

  // Helper to append or set common expense text into a textarea
  function appendExpenseDesc(textarea, val) {
    if (!textarea || !val) return;
    var current = textarea.value.trim();
    if (current) {
      textarea.value = current + ', ' + val;
    } else {
      textarea.value = val;
    }
    textarea.focus();
    if (typeof textarea.setSelectionRange === 'function') {
      var len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    }
  }

  // Quick-fill buttons
  document.querySelectorAll('.quick-fill-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = btn.dataset.target || 'asst-desc';
      var textarea = document.getElementById(targetId);
      appendExpenseDesc(textarea, btn.dataset.fill);
    });
  });

  // Dropdown quick-selects for description
  document.querySelectorAll('.desc-quick-select').forEach(function(sel) {
    sel.addEventListener('change', function() {
      var val = this.value;
      if (!val) return;
      var targetId = sel.dataset.target || (sel.id === 'ae-quick-desc' ? 'ae-desc' : sel.id === 'ee-quick-desc' ? 'ee-desc' : 'asst-desc');
      var textarea = document.getElementById(targetId);
      appendExpenseDesc(textarea, val);
      sel.value = ''; // Reset dropdown so the same or another option can be selected again
    });
  });

  // Assistant Photo Handlers
  document.getElementById('asst-btn-camera').addEventListener('click', function() {
    document.getElementById('asst-camera-input').click();
  });
  document.getElementById('asst-btn-gallery').addEventListener('click', function() {
    document.getElementById('asst-gallery-input').click();
  });
  document.getElementById('asst-camera-input').addEventListener('change', async function() {
    if (this.files && this.files[0]) {
      currentAsstPhoto = await handlePhotoSelection(this.files[0], 'asst-photo-preview', 'asst-preview-img', 'asst-preview-name', 'asst-preview-size');
    }
  });
  document.getElementById('asst-gallery-input').addEventListener('change', async function() {
    if (this.files && this.files[0]) {
      currentAsstPhoto = await handlePhotoSelection(this.files[0], 'asst-photo-preview', 'asst-preview-img', 'asst-preview-name', 'asst-preview-size');
    }
  });
  document.getElementById('asst-btn-remove-photo').addEventListener('click', function() {
    currentAsstPhoto = null;
    document.getElementById('asst-camera-input').value = '';
    document.getElementById('asst-gallery-input').value = '';
    document.getElementById('asst-photo-preview').style.display = 'none';
  });
  document.getElementById('asst-preview-img').addEventListener('click', function() {
    if (this.src) openReceiptModal(this.src, document.getElementById('asst-desc').value);
  });

  // Assistant expense form
  var isSubmittingAsstExpense = false;
  document.getElementById('asst-expense-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    if (isSubmittingAsstExpense) return;

    var siteId = asstSiteSelect.value;
    if (!siteId) {
      showToast('Please select a site first', 'error');
      return;
    }

    var expDate = document.getElementById('asst-date').value;
    var desc = document.getElementById('asst-desc').value.trim();
    var amount = Number(document.getElementById('asst-amount').value);

    if (!expDate || !desc || !amount) {
      showToast('All fields are required', 'error');
      return;
    }

    var submitBtn = this.querySelector('button[type="submit"]');
    var origBtnText = submitBtn ? submitBtn.textContent : '';

    isSubmittingAsstExpense = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = (currentAsstPhoto && currentAsstPhoto.data) ? 'Uploading to Drive...' : 'Saving...';
    }

    try {
      var payload = {
        expense_date: expDate,
        description: desc,
        amount: amount
      };
      if (currentAsstPhoto && currentAsstPhoto.data) {
        payload.image = { data: currentAsstPhoto.data, type: currentAsstPhoto.type };
        showToast('Uploading receipt to Google Drive...', 'info');
      }

      var res = await apiFetch('/api/sites/' + siteId + '/expenses', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        throw new Error(errData.message || errData.error || 'Failed to submit');
      }

      var resData = await res.json().catch(function() { return {}; });
      if (resData && resData.receipt_url) {
        showToast('Expense & Receipt saved to Google Drive!', 'success');
      } else if (payload.image) {
        showToast('Expense saved (Drive upload offline/pending)', 'warning');
      } else {
        showToast('Expense submitted successfully', 'success');
      }

      document.getElementById('asst-desc').value = '';
      var asstQuick = document.getElementById('asst-quick-desc');
      if (asstQuick) asstQuick.value = '';
      document.getElementById('asst-amount').value = '';
      document.getElementById('asst-date').value = todayISO();
      currentAsstPhoto = null;
      document.getElementById('asst-camera-input').value = '';
      document.getElementById('asst-gallery-input').value = '';
      document.getElementById('asst-photo-preview').style.display = 'none';

      await loadAssistantSiteExpenses(siteId);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      isSubmittingAsstExpense = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origBtnText;
      }
    }
  });

  // ── Session Restore ──
  if (getToken() && getRole()) {
    showApp();
  } else {
    showLogin();
  }

})();
