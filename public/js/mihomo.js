// Mihomo 代理管理页面 — Clash Verge 风格

let mihomoStatus = null;
let mihomoProxies = null;
let mihomoProfiles = null;
let mihomoSearchQuery = '';
let mihomoActiveGroup = '';

const MIHOMO_GROUP_TYPES = new Set([
    'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Smart'
]);

function mihomoArg(value) {
    return encodeURIComponent(String(value ?? '')).replace(/'/g, '%27');
}

function mihomoDecodeArg(value) {
    try {
        return decodeURIComponent(String(value ?? ''));
    } catch {
        return String(value ?? '');
    }
}

// 初始化 Mihomo 页面
function initMihomoPage() {
    if (!isLoggedIn) return;
    loadMihomoStatus();
    loadMihomoProfiles();
    loadMihomoProxies();
}

/* ==================== 状态 ==================== */

async function loadMihomoStatus() {
    try {
        const res = await authFetch('/admin/mihomo/status');
        const result = await res.json();
        if (result.success) {
            mihomoStatus = result.data;
            renderMihomoStatus();
        } else {
            showToast(result.message || '加载状态失败', 'error');
        }
    } catch (err) {
        showToast('加载状态失败: ' + err.message, 'error');
    }
}

function renderMihomoStatus() {
    const container = document.getElementById('mihomoStatusCards');
    if (!container || !mihomoStatus) return;

    const s = mihomoStatus;
    const statusClass = s.running ? 'success' : 'danger';
    const statusText = s.running ? '运行中' : '已停止';
    const proxyText = s.proxyActive ? '已接管' : (s.setAsProjectProxy ? '待接管' : '未接管');

    container.innerHTML = `
        <div class="mihomo-status-card ${statusClass}">
            <div class="mihomo-status-icon">${s.running ? '🟢' : '🔴'}</div>
            <div class="mihomo-status-info">
                <div class="mihomo-status-label">状态</div>
                <div class="mihomo-status-value">${escapeHtml(statusText)}</div>
            </div>
        </div>
        <div class="mihomo-status-card info">
            <div class="mihomo-status-icon">📁</div>
            <div class="mihomo-status-info">
                <div class="mihomo-status-label">Profile</div>
                <div class="mihomo-status-value">${escapeHtml(s.currentProfile || '-')}</div>
            </div>
        </div>
        <div class="mihomo-status-card info">
            <div class="mihomo-status-icon">🌐</div>
            <div class="mihomo-status-info">
                <div class="mihomo-status-label">端口</div>
                <div class="mihomo-status-value">${escapeHtml(String(s.mixedPort || '-'))}</div>
            </div>
        </div>
        <div class="mihomo-status-card ${s.proxyActive ? 'success' : 'warning'}">
            <div class="mihomo-status-icon">🔗</div>
            <div class="mihomo-status-info">
                <div class="mihomo-status-label">项目代理</div>
                <div class="mihomo-status-value">${escapeHtml(proxyText)}</div>
            </div>
        </div>
        <div class="mihomo-status-card ${s.autoStart ? 'success' : 'secondary'}">
            <div class="mihomo-status-icon">⚡</div>
            <div class="mihomo-status-info">
                <div class="mihomo-status-label">自动启动</div>
                <div class="mihomo-status-value">${s.autoStart ? '开启' : '关闭'}</div>
            </div>
        </div>
        ${s.lastError ? `
        <div class="mihomo-status-card danger">
            <div class="mihomo-status-icon">⚠️</div>
            <div class="mihomo-status-info">
                <div class="mihomo-status-label">错误</div>
                <div class="mihomo-status-value" style="font-size:0.75rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.lastError)}</div>
            </div>
        </div>
        ` : ''}
    `;
}

/* ==================== 启停 ==================== */

async function startMihomo() {
    if (!mihomoProfiles) {
        showToast('Profile 信息仍在加载，请稍候', 'warning');
        loadMihomoProfiles();
        return;
    }
    if (!(mihomoProfiles.profiles || []).length) {
        showToast('请先导入一个 Profile', 'warning');
        showMihomoImportModal();
        return;
    }
    showLoading('正在启动 Mihomo...');
    try {
        const res = await authFetch('/admin/mihomo/start', { method: 'POST' });
        const result = await res.json();
        hideLoading();
        if (result.success) {
            mihomoStatus = result.data;
            renderMihomoStatus();
            showToast('Mihomo 已启动', 'success');
            loadMihomoProfiles();
            loadMihomoProxies();
        } else {
            showToast(result.message || '启动失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('启动失败: ' + err.message, 'error');
    }
}

async function stopMihomo() {
    const confirmed = await showConfirm('确定要停止 Mihomo 吗？', '停止确认');
    if (!confirmed) return;
    showLoading('正在停止 Mihomo...');
    try {
        const res = await authFetch('/admin/mihomo/stop', { method: 'POST' });
        const result = await res.json();
        hideLoading();
        if (result.success) {
            mihomoStatus = result.data;
            renderMihomoStatus();
            showToast('Mihomo 已停止', 'success');
        } else {
            showToast(result.message || '停止失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('停止失败: ' + err.message, 'error');
    }
}

async function restartMihomo() {
    const confirmed = await showConfirm('确定要重启 Mihomo 吗？', '重启确认');
    if (!confirmed) return;
    showLoading('正在重启 Mihomo...');
    try {
        const res = await authFetch('/admin/mihomo/restart', { method: 'POST' });
        const result = await res.json();
        hideLoading();
        if (result.success) {
            mihomoStatus = result.data;
            renderMihomoStatus();
            showToast('Mihomo 已重启', 'success');
            loadMihomoProfiles();
            loadMihomoProxies();
        } else {
            showToast(result.message || '重启失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('重启失败: ' + err.message, 'error');
    }
}

/* ==================== Profile ==================== */

async function loadMihomoProfiles() {
    try {
        const res = await authFetch('/admin/mihomo/profiles');
        const result = await res.json();
        if (result.success) {
            mihomoProfiles = result.data;
            renderMihomoProfiles();
        }
    } catch (err) {
        // 静默失败
    }
}

function renderMihomoProfiles() {
    const list = document.getElementById('mihomoProfileList');
    const current = document.getElementById('mihomoCurrentProfile');
    if (!list || !mihomoProfiles) return;

    const profiles = mihomoProfiles.profiles || [];
    const activeName = mihomoStatus?.currentProfile || mihomoProfiles.currentProfile;

    if (current) {
        current.textContent = activeName ? `当前: ${activeName}` : '当前: -';
    }

    if (!profiles.length) {
        list.innerHTML = '<div class="empty-state-small">暂无 Profile，请导入</div>';
        return;
    }

    list.innerHTML = profiles.map(p => {
        const isActive = p.name === activeName;
        const metaParts = [String(p.source || '').startsWith('url') ? 'URL 订阅' : '本地 YAML'];
        if (p.updatedAt) metaParts.push(new Date(p.updatedAt).toLocaleString());
        return `
            <div class="mihomo-profile-item ${isActive ? 'active' : ''}">
                <div class="mihomo-profile-info">
                    <div class="mihomo-profile-name">${escapeHtml(p.name)}</div>
                    <div class="mihomo-profile-meta">${escapeHtml(metaParts.join(' · '))}</div>
                </div>
                <div class="mihomo-profile-actions">
                    ${isActive ? '<span class="status enabled">当前</span>' : `<button class="btn btn-xs btn-success" onclick="switchMihomoProfileByArg('${mihomoArg(p.name)}')">切换</button>`}
                    <button class="btn btn-xs btn-danger" onclick="deleteMihomoProfileByArg('${mihomoArg(p.name)}')">删除</button>
                </div>
            </div>
        `;
    }).join('');
}

async function switchMihomoProfile(name) {
    showLoading('正在切换 Profile...');
    try {
        const res = await authFetch('/admin/mihomo/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile: name })
        });
        const result = await res.json();
        hideLoading();
        if (result.success) {
            mihomoStatus = result.data;
            renderMihomoStatus();
            showToast('Profile 已切换', 'success');
            loadMihomoProfiles();
            loadMihomoProxies();
        } else {
            showToast(result.message || '切换失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('切换失败: ' + err.message, 'error');
    }
}

function switchMihomoProfileByArg(name) {
    return switchMihomoProfile(mihomoDecodeArg(name));
}

async function deleteMihomoProfile(name) {
    const confirmed = await showConfirm(`确定要删除 Profile "${name}" 吗？`, '删除确认');
    if (!confirmed) return;
    showLoading('正在删除...');
    try {
        const res = await authFetch(`/admin/mihomo/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const result = await res.json();
        hideLoading();
        if (result.success) {
            showToast('Profile 已删除', 'success');
            loadMihomoProfiles();
        } else {
            showToast(result.message || '删除失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('删除失败: ' + err.message, 'error');
    }
}

function deleteMihomoProfileByArg(name) {
    return deleteMihomoProfile(mihomoDecodeArg(name));
}

/* ==================== 导入 ==================== */

function showMihomoImportModal() {
    if (document.getElementById('mihomoImportModal')) return;
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.id = 'mihomoImportModal';
    modal.innerHTML = `
        <div class="modal-content modal-lg">
            <div class="modal-title">📥 导入 Profile</div>
            <div class="import-tabs">
                <button class="import-tab active" onclick="switchMihomoImportTab('url', this)">🔗 URL 订阅</button>
                <button class="import-tab" onclick="switchMihomoImportTab('yaml', this)">📋 YAML 内容</button>
            </div>
            <div id="mihomoImportUrlPanel" class="import-tab-content">
                <div class="form-group compact">
                    <label>名称（可选）</label>
                    <input type="text" id="mihomoImportName" placeholder="如: my-sub">
                </div>
                <div class="form-group compact">
                    <label>订阅 URL</label>
                    <input type="text" id="mihomoImportUrl" placeholder="https://example.com/subscribe?token=xxx">
                </div>
            </div>
            <div id="mihomoImportYamlPanel" class="import-tab-content hidden">
                <div class="form-group compact">
                    <label>名称（可选）</label>
                    <input type="text" id="mihomoImportYamlName" placeholder="如: my-config">
                </div>
                <div class="form-group compact">
                    <label>YAML 配置内容</label>
                    <textarea id="mihomoImportYamlContent" rows="8" placeholder="粘贴 YAML 内容..."></textarea>
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="document.getElementById('mihomoImportModal').remove()">取消</button>
                <button class="btn btn-success" onclick="submitMihomoImport()">导入</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    wireModalBackdropClose(modal, () => modal.remove());
}

function switchMihomoImportTab(type, btn) {
    btn.parentElement.querySelectorAll('.import-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('mihomoImportUrlPanel').classList.toggle('hidden', type !== 'url');
    document.getElementById('mihomoImportYamlPanel').classList.toggle('hidden', type !== 'yaml');
}

async function submitMihomoImport() {
    const urlPanel = document.getElementById('mihomoImportUrlPanel');
    const isUrl = !urlPanel.classList.contains('hidden');

    if (isUrl) {
        const name = document.getElementById('mihomoImportName').value.trim();
        const url = document.getElementById('mihomoImportUrl').value.trim();
        if (!url) { showToast('请输入订阅 URL', 'warning'); return; }
        showLoading('正在导入...');
        try {
            const res = await authFetch('/admin/mihomo/profiles/import-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name || undefined, url })
            });
            const result = await res.json();
            hideLoading();
            if (result.success) {
                showToast('导入成功', 'success');
                document.getElementById('mihomoImportModal')?.remove();
                if (result.data?.status) { mihomoStatus = result.data.status; renderMihomoStatus(); }
                loadMihomoProfiles(); loadMihomoProxies();
            } else {
                showToast(result.message || '导入失败', 'error');
            }
        } catch (err) {
            hideLoading();
            showToast('导入失败: ' + err.message, 'error');
        }
    } else {
        const name = document.getElementById('mihomoImportYamlName').value.trim();
        const content = document.getElementById('mihomoImportYamlContent').value;
        if (!content.trim()) { showToast('请输入 YAML 内容', 'warning'); return; }
        showLoading('正在导入...');
        try {
            const res = await authFetch('/admin/mihomo/profiles/import-yaml', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name || undefined, content })
            });
            const result = await res.json();
            hideLoading();
            if (result.success) {
                showToast('导入成功', 'success');
                document.getElementById('mihomoImportModal')?.remove();
                if (result.data?.status) { mihomoStatus = result.data.status; renderMihomoStatus(); }
                loadMihomoProfiles(); loadMihomoProxies();
            } else {
                showToast(result.message || '导入失败', 'error');
            }
        } catch (err) {
            hideLoading();
            showToast('导入失败: ' + err.message, 'error');
        }
    }
}

/* ==================== 代理组与节点（Clash Verge 风格） ==================== */

function getGroupTypeColor(type) {
    const map = {
        'Selector': '#3b82f6',
        'URLTest': '#f59e0b',
        'Fallback': '#8b5cf6',
        'LoadBalance': '#ec4899',
        'Relay': '#14b8a6',
        'Smart': '#22c55e',
        'GLOBAL': '#64748b'
    };
    return map[type] || '#0891b2';
}

function getProxyGroups() {
    const all = mihomoProxies?.proxies || {};
    const groups = [];
    for (const key of Object.keys(all)) {
        const p = all[key];
        if (!p) continue;
        if (MIHOMO_GROUP_TYPES.has(p.type)) {
            groups.push(p);
        }
    }
    const priority = ['GLOBAL', 'PROXY', 'Proxy', '🚀 节点选择', '节点选择', 'Auto', '自动选择', '♻️ 自动选择'];
    return groups.sort((a, b) => {
        const ai = priority.indexOf(a.name);
        const bi = priority.indexOf(b.name);
        if (ai !== -1 || bi !== -1) {
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        }
        return String(a.name).localeCompare(String(b.name));
    });
}

async function loadMihomoProxies() {
    try {
        const res = await authFetch('/admin/mihomo/proxies');
        const result = await res.json();
        if (result.success) {
            mihomoProxies = result.data;
            const groups = getProxyGroups();
            if (!mihomoActiveGroup && groups.length) {
                mihomoActiveGroup = groups.find(g => g.name !== 'GLOBAL')?.name || groups[0]?.name;
            }
            if (groups.length && !groups.find(g => g.name === mihomoActiveGroup)) {
                mihomoActiveGroup = groups[0]?.name || '';
            }
            renderMihomoGroupNav();
            renderMihomoGroupContent();
        } else {
            document.getElementById('mihomoGroupNav').innerHTML = `
                <div class="empty-state-small" style="padding:1rem;">${escapeHtml(result.message || '加载失败')}</div>`;
            document.getElementById('mihomoGroupHeader').innerHTML = '';
            document.getElementById('mihomoNodeGrid').innerHTML = '';
        }
    } catch (err) {
        document.getElementById('mihomoGroupNav').innerHTML = `
            <div class="empty-state-small" style="padding:1rem;">${escapeHtml(err.message)}</div>`;
        document.getElementById('mihomoGroupHeader').innerHTML = '';
        document.getElementById('mihomoNodeGrid').innerHTML = '';
    }
}

function renderMihomoGroupNav() {
    const nav = document.getElementById('mihomoGroupNav');
    if (!nav || !mihomoProxies) return;
    const groups = getProxyGroups();
    if (!groups.length) {
        nav.innerHTML = '<div class="empty-state-small" style="padding:1rem;">暂无代理组</div>';
        return;
    }
    nav.innerHTML = groups.map(g => {
        const isActive = g.name === mihomoActiveGroup;
        const color = getGroupTypeColor(g.type);
        return `
            <div class="mihomo-nav-item ${isActive ? 'active' : ''}"
                 onclick="switchMihomoGroupByArg('${mihomoArg(g.name)}')"
                 style="--group-accent:${color}">
                <div class="mihomo-nav-name">${escapeHtml(g.name)}</div>
                <div class="mihomo-nav-meta">
                    <span class="mihomo-nav-badge" style="background:${color}">${escapeHtml(g.type)}</span>
                    <span class="mihomo-nav-now">${escapeHtml(g.now || '-')}</span>
                </div>
            </div>
        `;
    }).join('');
}

function switchMihomoGroup(name) {
    mihomoActiveGroup = name;
    mihomoSearchQuery = '';
    const input = document.getElementById('mihomoSearchInput');
    if (input) input.value = '';
    renderMihomoGroupNav();
    renderMihomoGroupContent();
}

function switchMihomoGroupByArg(name) {
    return switchMihomoGroup(mihomoDecodeArg(name));
}

function renderMihomoGroupContent() {
    const header = document.getElementById('mihomoGroupHeader');
    const grid = document.getElementById('mihomoNodeGrid');
    if (!header || !grid || !mihomoProxies || !mihomoActiveGroup) {
        if (header) header.innerHTML = '';
        if (grid) grid.innerHTML = '<div class="empty-state-small">请选择代理组</div>';
        return;
    }

    const all = mihomoProxies.proxies;
    const group = all[mihomoActiveGroup];
    if (!group) {
        header.innerHTML = '<div class="empty-state-small">组信息不存在</div>';
        grid.innerHTML = '';
        return;
    }

    const color = getGroupTypeColor(group.type);
    const now = group.now || '';
    const nodeNames = (group.all || []).filter(n => n !== 'REJECT');
    const query = mihomoSearchQuery.trim().toLowerCase();
    const filtered = query ? nodeNames.filter(n => n.toLowerCase().includes(query)) : nodeNames;

    // 组标题卡片
    header.innerHTML = `
        <div class="mihomo-header-card">
            <div class="mihomo-header-left">
                <div class="mihomo-header-title">
                    <span class="mihomo-header-badge" style="background:${color}">${escapeHtml(group.type)}</span>
                    <span>${escapeHtml(group.name)}</span>
                </div>
                <div class="mihomo-header-sub">
                    当前选中: <span class="mihomo-header-current">${escapeHtml(now || '-')}</span>
                    · ${nodeNames.length} 节点
                </div>
            </div>
            <div class="mihomo-header-right">
                <button class="btn btn-xs btn-info" onclick="testMihomoGroupDelayByArg('${mihomoArg(group.name)}')">🔄 组测速</button>
            </div>
        </div>
    `;

    if (!filtered.length) {
        grid.innerHTML = query
            ? '<div class="empty-state-small" style="padding:2rem;">无匹配节点</div>'
            : '<div class="empty-state-small" style="padding:2rem;">该组暂无可用节点</div>';
        return;
    }

    const isGlobal = group.name === 'GLOBAL';

    grid.innerHTML = filtered.map(nodeName => {
        const nodeInfo = all[nodeName];
        const isSubGroup = nodeInfo && MIHOMO_GROUP_TYPES.has(nodeInfo.type);
        const isDirect = nodeName === 'DIRECT';
        const isSelectable = group.type === 'Selector' || isGlobal;
        const isActive = nodeName === now;
        const delay = nodeInfo?.history?.[0]?.delay;
        const delayNum = typeof delay === 'number' ? delay : null;
        const delayClass = delayNum !== null && delayNum > 500 ? 'slow' : (delayNum !== null && delayNum >= 0 ? 'fast' : '');

        if (isSubGroup) {
            const subColor = getGroupTypeColor(nodeInfo.type);
            return `
                <div class="mihomo-node-card sub-group ${isActive ? 'active' : ''}"
                     onclick="${isSelectable ? `selectMihomoProxyByArg('${mihomoArg(group.name)}', '${mihomoArg(nodeName)}')` : `switchMihomoGroupByArg('${mihomoArg(nodeName)}')`}">
                    <div class="mihomo-node-name">${escapeHtml(nodeName)}</div>
                    <div class="mihomo-node-meta">
                        <div class="mihomo-node-tags">
                            <span class="mihomo-node-tag" style="background:${subColor}22;color:${subColor}">${escapeHtml(nodeInfo.type)}</span>
                        </div>
                        <div class="mihomo-node-right">
                            ${isSelectable ? `<button class="mihomo-node-check" onclick="event.stopPropagation(); selectMihomoProxyByArg('${mihomoArg(group.name)}', '${mihomoArg(nodeName)}')">选用</button>` : ''}
                            <button class="mihomo-node-check" onclick="event.stopPropagation(); switchMihomoGroupByArg('${mihomoArg(nodeName)}')">进入</button>
                        </div>
                    </div>
                    ${isActive ? '<div class="mihomo-node-active-mark">✓</div>' : ''}
                </div>
            `;
        }

        // 标签
        const tags = [];
        if (isDirect) tags.push({ text: 'DIRECT', cls: 'direct' });
        if (nodeInfo?.type && !isDirect) tags.push({ text: nodeInfo.type, cls: 'type' });
        if (nodeInfo?.udp) tags.push({ text: 'UDP', cls: 'udp' });
        if (nodeInfo?.xudp) tags.push({ text: 'XUDP', cls: 'xudp' });

        return `
            <div class="mihomo-node-card ${isActive ? 'active' : ''} ${!isSelectable ? 'auto-group' : ''}"
                 onclick="${isSelectable ? `selectMihomoProxyByArg('${mihomoArg(group.name)}', '${mihomoArg(nodeName)}')` : `testMihomoNodeDelayByArg('${mihomoArg(nodeName)}')`}">
                <div class="mihomo-node-name">${escapeHtml(nodeName)}</div>
                <div class="mihomo-node-meta">
                    <div class="mihomo-node-tags">
                        ${tags.map(t => `<span class="mihomo-node-tag ${t.cls}">${escapeHtml(t.text)}</span>`).join('')}
                    </div>
                    <div class="mihomo-node-right">
                        ${delayNum !== null
                            ? `<span class="mihomo-node-delay ${delayClass}">${delayNum}ms</span>`
                            : '<span class="mihomo-node-delay empty">-</span>'}
                        <button class="mihomo-node-check" onclick="event.stopPropagation(); testMihomoNodeDelayByArg('${mihomoArg(nodeName)}')">测速</button>
                        ${!isSelectable ? '<span class="mihomo-auto-hint">自动组</span>' : ''}
                    </div>
                </div>
                ${isActive ? '<div class="mihomo-node-active-mark">✓</div>' : ''}
            </div>
        `;
    }).join('');
}

function onMihomoSearch(value) {
    mihomoSearchQuery = value;
    renderMihomoGroupContent();
}

async function selectMihomoProxy(group, name) {
    showLoading('正在切换节点...');
    try {
        const res = await authFetch(`/admin/mihomo/proxies/${encodeURIComponent(group)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const result = await res.json();
        hideLoading();
        if (result.success) {
            showToast(`已切换到 ${name}`, 'success');
            if (mihomoProxies?.proxies?.[group]) {
                mihomoProxies.proxies[group].now = name;
                renderMihomoGroupNav();
                renderMihomoGroupContent();
            }
            setTimeout(() => loadMihomoProxies(), 800);
        } else {
            showToast(result.message || '切换失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('切换失败: ' + err.message, 'error');
    }
}

function selectMihomoProxyByArg(group, name) {
    return selectMihomoProxy(mihomoDecodeArg(group), mihomoDecodeArg(name));
}

async function testMihomoGroupDelay(name) {
    showLoading('正在测速...');
    try {
        const res = await authFetch(`/admin/mihomo/proxies/${encodeURIComponent(name)}/delay?timeout=5000`);
        const result = await res.json();
        hideLoading();
        if (result.success) {
            showToast(`${name} 延迟: ${result.data?.delay ?? '-'}ms`, 'info');
            loadMihomoProxies();
        } else {
            showToast(result.message || '测速失败', 'error');
        }
    } catch (err) {
        hideLoading();
        showToast('测速失败: ' + err.message, 'error');
    }
}

function testMihomoGroupDelayByArg(name) {
    return testMihomoGroupDelay(mihomoDecodeArg(name));
}

async function testMihomoNodeDelay(name) {
    try {
        const res = await authFetch(`/admin/mihomo/proxies/${encodeURIComponent(name)}/delay?timeout=5000`);
        const result = await res.json();
        if (result.success) {
            showToast(`${name} 延迟: ${result.data?.delay ?? '-'}ms`, 'info');
            loadMihomoProxies();
        } else {
            showToast(result.message || '测速失败', 'error');
        }
    } catch (err) {
        showToast('测速失败: ' + err.message, 'error');
    }
}

function testMihomoNodeDelayByArg(name) {
    return testMihomoNodeDelay(mihomoDecodeArg(name));
}

function cleanupMihomoPage() {
    // 预留
}
