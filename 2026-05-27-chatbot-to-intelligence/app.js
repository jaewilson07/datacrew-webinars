/*
  app.js — DEMO interface behavior.

  This script owns the browser-side orchestration for the DEMO Domo Pro-Code app. It loads Domo
  datasets, builds the reference catalog, manages the chat composer, performs preflight context
  confirmation, calls Code Engine packages, renders SQL results, and maintains Tier 3 template and
  playbook memory through AppDB.

  The workflow intentionally follows this hierarchy before the LLM is allowed to generate SQL:
  reference and metric tag confirmation, then playbook confirmation, then automatic learned-template
  reuse, and finally LLM fallback. This order keeps reusable context fast and safe while preserving
  the user’s ability to edit ambiguous natural-language matches before anything is submitted.
*/

(function () {
  'use strict';

  /*
    This section defines the app’s default runtime contract, including dataset aliases, Code Engine package aliases,
    AppDB collections, paging limits, reference categories, and lookup mappings.
  */
  const DEFAULT_CONFIG = Object.freeze({
    facilitiesAlias: 'facilities',
    transactionsAlias: 'transactions',
    transactionsDatasetId: '',
    facilitiesDatasetId: '',
    tier1PackageAlias: 'tier1Chat',
    tier2PackageAlias: 'tier2Chat',
    schemaPackageAlias: 'getSchema',
    attemptSqlPackageAlias: 'attemptSQL',
    metricsUrl: 'metrics.json',
    templatesCollection: 'datacrew_demo_templates',
    playbooksCollection: 'datacrew_demo_playbooks',
    templateMatchThreshold: 78,
    openAIApiKey: '',
    openAIModel: 'gpt-5.1-chat-latest',
    maxChatTurns: 6,
    maxRows: 5000,
    maxSqlAttempts: 3,
    pageSize: 50000,
    maxReferenceRows: 250000,
    lookupMappings: Object.freeze([
      {
        name: 'facility_lookup',
        lookupAlias: 'facilities',
        lookupTable: 'facilities',
        transactionTable: 'transactions',
        primaryKey: 'facility_id',
        secondaryKey: 'facility_id',
        transactionKey: 'facility_id',
        lookupKey: 'facility_id',
        defaultDisplayColumn: 'facility_name',
        defaultJoinColumns: ['facility_name'],
        filterableColumns: ['facility_name', 'facility_status', 'region_name', 'facility_type']
      }
    ]),
    categories: Object.freeze({
      facility: { label: 'Facility', source: 'facilities', primaryColumn: 'facility_name', secondaryColumn: 'facility_id' },
      facilityStatus: { label: 'Facility Status', source: 'facilities', primaryColumn: 'facility_status' },
      metrics: { label: 'Metric', source: 'metrics', primaryColumn: 'name' },
      robotClass: { label: 'Robot Class', source: 'transactions', primaryColumn: 'robot_class' },
      shift: { label: 'Shift', source: 'transactions', primaryColumn: 'shift_name' },
      task: { label: 'Task', source: 'transactions', primaryColumn: 'task_type' },
      taskStatus: { label: 'Task Status', source: 'transactions', primaryColumn: 'task_status' },
      priority: { label: 'Priority', source: 'transactions', primaryColumn: 'assigned_priority' },
      failureReason: { label: 'Failure Reason', source: 'transactions', primaryColumn: 'failure_reason_code' },
      sourceSystem: { label: 'Source System', source: 'transactions', primaryColumn: 'source_system' }
    })
  });

  /*
    This section defines the linguistic thresholds used by the playbook matcher. The thresholds keep short prompts from
    over-matching while still allowing longer natural-language requests to reuse saved playbooks quickly.
  */
  const PLAYBOOK_MATCH_THRESHOLD = 0.62;
  const PLAYBOOK_MATCH_SHORT_THRESHOLD = 0.72;
  const PLAYBOOK_MATCH_MIN_WORDS = 3;
  const PLAYBOOK_MATCH_MIN_OVERLAP = 2;

  /*
    This stopword list removes common helper words before semantic playbook matching. Keeping these words out of the
    match sets helps the matcher focus on operational nouns, metric names, time windows, and analytical intent.
  */
  const PLAYBOOK_MATCH_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'had',
    'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or', 'our',
    'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
    'those', 'to', 'too', 'up', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
    'why', 'with', 'you', 'your', 'can', 'could', 'would', 'should', 'will', 'may', 'do',
    'does', 'did', 'done', 'doing', 'been', 'being', 'also', 'about', 'over', 'under',
    'between', 'within', 'without', 'per', 'vs', 'via', 'days'
  ]);

  /*
    This state object holds the mutable app session. It keeps the active tier, loaded references, cached AppDB memory,
    current chat history, pending context confirmation, and modal state in one predictable structure.
  */
  const state = {
    config: { ...DEFAULT_CONFIG, categories: DEFAULT_CONFIG.categories },
    activeCategory: 'metrics',
    activeTier: 'tier3',
    referencesDisabled: false,
    playbooksDisabled: true,
    isBusy: false,
    searchText: '',
    transactionSchema: null,
    chatTurns: [],
    facilityRows: [],
    facilityLookupById: new Map(),
    metricsCatalog: [],
    templates: [],
    playbooks: [],
    lookupReferenceIndex: [],
    lastResult: null,
    pendingContextConfirmation: null,
    declinedReusableSignatures: new Set(),
    references: {
      facility: [],
      facilityStatus: [],
      metrics: [],
      robotClass: [],
      shift: [],
      task: [],
      taskStatus: [],
      priority: [],
      failureReason: [],
      sourceSystem: []
    },
    referenceById: new Map(),
    activeModal: null
  };

  /*
    This object stores DOM references after startup. Centralizing DOM handles prevents repeated querySelector calls
    and gives later render functions a shared vocabulary for the interface.
  */
  const dom = {};

  /*
    Startup, DOM wiring, and configuration loading.
  */

  /*
    This function caches every DOM node that the app reads or mutates after startup. Keeping these references
    together makes later UI logic easier for a human or future LLM to trace.
  */
  function cacheDom() {
    dom.body = document.body;
    dom.splashStatus = document.getElementById('appSplashStatus');
    dom.referencesPanel = document.getElementById('referencesPanel');
    dom.playbooksButton = document.getElementById('playbooksButton');
    dom.llmStatusGauge = document.getElementById('llmStatusGauge');
    dom.llmStatusText = document.getElementById('llmStatusText');
    dom.referenceList = document.getElementById('referenceList');
    dom.referenceStatus = document.getElementById('referenceStatus');
    dom.referenceSearch = document.getElementById('referenceSearch');
    dom.referenceTabs = Array.from(document.querySelectorAll('.reference-tab'));
    dom.refreshReferencesButton = document.getElementById('refreshReferencesButton');
    dom.chatTranscript = document.getElementById('chatTranscript');
    dom.composerInput = document.getElementById('composerInput');
    dom.selectedReferenceCount = document.getElementById('selectedReferenceCount');
    dom.modeButtons = Array.from(document.querySelectorAll('.mode-button'));
    dom.resetPromptButton = document.getElementById('resetPromptButton');
    dom.sendPromptButton = document.getElementById('sendPromptButton');
    dom.contextConfirmOverlay = document.getElementById('contextConfirmOverlay');
    dom.contextConfirmCloseButton = document.getElementById('contextConfirmCloseButton');
    dom.contextConfirmEditButton = document.getElementById('contextConfirmEditButton');
    dom.contextConfirmUseButton = document.getElementById('contextConfirmUseButton');
    dom.contextConfirmPrompt = document.getElementById('contextConfirmPrompt');
    dom.contextConfirmReferencesSection = document.getElementById('contextConfirmReferencesSection');
    dom.contextConfirmReferencesCount = document.getElementById('contextConfirmReferencesCount');
    dom.contextConfirmReferencesList = document.getElementById('contextConfirmReferencesList');
    dom.contextConfirmPatternSection = document.getElementById('contextConfirmPatternSection');
    dom.contextConfirmPatternScore = document.getElementById('contextConfirmPatternScore');
    dom.contextConfirmPatternList = document.getElementById('contextConfirmPatternList');
  }

  /*
    This function attaches all persistent interface event handlers. It connects reference search, tier
    switching, composer submission, reset behavior, context confirmation, modal closing, and playbook access.
  */
  function wireEvents() {
    dom.referenceTabs.forEach(button => {
      button.addEventListener('click', () => {
        if (state.referencesDisabled) return;
        state.activeCategory = button.dataset.category || 'facility';
        renderTabs();
        renderReferences();
      });
    });

    dom.modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        state.activeTier = button.dataset.tier || 'tier1';
        applyTierAvailability();
      });
    });

    dom.referenceSearch.addEventListener('input', () => {
      if (state.referencesDisabled) return;
      state.searchText = dom.referenceSearch.value.trim().toLowerCase();
      renderReferences();
    });

    dom.refreshReferencesButton.addEventListener('click', async () => {
      if (state.referencesDisabled || state.isBusy) return;
      await loadAndRenderReferences();
    });

    dom.composerInput.addEventListener('input', updateInsertedReferenceCount);

    dom.resetPromptButton.addEventListener('click', () => {
      if (state.isBusy) return;
      resetAppToInitialState();
    });

    dom.sendPromptButton.addEventListener('click', runActiveTierWorkflow);

    dom.composerInput.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        runActiveTierWorkflow();
      }
    });

    dom.playbooksButton.addEventListener('click', () => {
      if (state.playbooksDisabled || state.isBusy) return;
      openPlaybooksMenu();
    });

    dom.contextConfirmUseButton?.addEventListener('click', () => resolveContextConfirmation(true));
    dom.contextConfirmEditButton?.addEventListener('click', () => resolveContextConfirmation(false));
    dom.contextConfirmCloseButton?.addEventListener('click', () => resolveContextConfirmation(false));

    dom.contextConfirmOverlay?.addEventListener('mousedown', event => {
      if (event.target === dom.contextConfirmOverlay) resolveContextConfirmation(false);
    });
  }

  /*
    This function loads config.json and merges it with the default configuration. It preserves safe defaults
    when config.json is missing or incomplete.
  */
  async function loadConfig() {
    try {
      const response = await fetch('config.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`config.json returned HTTP ${response.status}`);
      const runtime = await response.json();
      state.config = {
        ...DEFAULT_CONFIG,
        ...runtime,
        categories: DEFAULT_CONFIG.categories,
        lookupMappings: runtime.lookupMappings || DEFAULT_CONFIG.lookupMappings
      };
    } catch (error) {
      console.warn('[DEMO] config.json could not be loaded; defaults will be used.', error);
    }
  }

  /*
    This function loads metrics.json and normalizes the metric catalog. The resulting catalog powers metric
    references, metric tag detection, and learned-template rendering.
  */
  async function loadMetricsCatalog() {
    try {
      const response = await fetch(state.config.metricsUrl || 'metrics.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`metrics.json returned HTTP ${response.status}`);
      const payload = await response.json();
      const list = Array.isArray(payload?.metrics) ? payload.metrics : Array.isArray(payload) ? payload : [];
      state.metricsCatalog = list.map(normalizeMetric).filter(metric => metric.key && metric.name && metric.calculation);
    } catch (error) {
      console.warn('[DEMO] metrics.json could not be loaded.', error);
      state.metricsCatalog = [];
    }
  }

  /*
    This function converts a metric definition into a stable object shape. It ensures aliases, calculation SQL,
    units, directionality, and date columns are available in predictable fields.
  */
  function normalizeMetric(metric) {
    const name = cleanText(metric.name);
    return {
      kind: 'metric',
      key: cleanText(metric.key || name.toLowerCase().replace(/\s+/g, '_')),
      name,
      label: name,
      tokenLabel: `Metric: ${name}`,
      aliases: Array.isArray(metric.aliases) ? metric.aliases.map(cleanText).filter(Boolean) : [],
      description: cleanText(metric.description),
      calculation: cleanText(metric.calculation),
      defaultAlias: cleanText(metric.defaultAlias),
      unit: cleanText(metric.unit),
      directionality: cleanText(metric.directionality),
      dateColumn: cleanText(metric.dateColumn)
    };
  }

  /*
    This function pages through a Domo dataset alias until all available rows are loaded or the configured
    reference-row cap is reached. It is used to build local reference indexes without exposing server-side
    credentials.
  */
  async function fetchAllDomoRows(alias, options = {}) {
    const limit = Math.max(1, Math.min(50000, Number(options.limit || state.config.pageSize || 50000)));
    const maxRows = Math.max(limit, Number(options.maxRows || state.config.maxReferenceRows || 250000));
    const rows = [];
    let offset = 0;

    while (rows.length < maxRows) {
      const page = await window.domo.get(`/data/v1/${encodeURIComponent(alias)}?limit=${limit}&offset=${offset}`);
      const normalized = normalizeDomoPage(page);
      rows.push(...normalized);
      if (normalized.length < limit) break;
      offset += limit;
    }

    return rows.slice(0, maxRows);
  }

  /*
    This function converts the possible domo.get response shapes into a single row array. It lets reference
    loading tolerate matrix, row-object, and wrapped response formats.
  */
  function normalizeDomoPage(page) {
    if (Array.isArray(page)) return page;
    if (Array.isArray(page?.rows)) return page.rows;
    if (Array.isArray(page?.data)) return page.data;
    if (Array.isArray(page?.response)) return page.response;
    return [];
  }

  /*
    Reference catalog construction from facility, transaction, and metric data.
  */

  /*
    This function rebuilds all searchable reference groups from facility rows, transaction rows, and metric
    definitions. It also refreshes lookup indexes used later for filters and enrichment.
  */
  function buildReferenceState(facilityRows, transactionRows) {
    state.referenceById = new Map();
    state.facilityRows = facilityRows;
    state.facilityLookupById = new Map();

    facilityRows.forEach(row => {
      const id = cleanText(row.facility_id);
      if (id) state.facilityLookupById.set(id.toLowerCase(), row);
    });

    state.references.facility = buildFacilityReferences(facilityRows);
    state.references.facilityStatus = buildFacilityStatusReferences(facilityRows);
    state.lookupReferenceIndex = buildLookupValueReferences(facilityRows);
    state.references.metrics = buildMetricReferences(state.metricsCatalog);
    state.references.robotClass = buildSingleColumnReferences(transactionRows, 'robotClass');
    state.references.shift = buildSingleColumnReferences(transactionRows, 'shift');
    state.references.task = buildSingleColumnReferences(transactionRows, 'task');
    state.references.taskStatus = buildSingleColumnReferences(transactionRows, 'taskStatus');
    state.references.priority = buildSingleColumnReferences(transactionRows, 'priority');
    state.references.failureReason = buildSingleColumnReferences(transactionRows, 'failureReason');
    state.references.sourceSystem = buildSingleColumnReferences(transactionRows, 'sourceSystem');

    [...Object.values(state.references).flat(), ...state.lookupReferenceIndex].forEach(item => state.referenceById.set(item.id, item));
  }

  /*
    This function turns facility lookup rows into facility reference buttons and lookup index entries. It
    captures the facility id, display name, region, status, and type needed for downstream filtering.
  */
  function buildFacilityReferences(rows) {
    const map = new Map();

    rows.forEach(row => {
      const label = cleanText(row.facility_name);
      const keyValue = cleanText(row.facility_id);
      if (!label || !keyValue) return;

      const key = keyValue.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          id: `ref_facility_${safeId(keyValue)}`,
          kind: 'reference',
          category: 'facility',
          label,
          tokenLabel: `Facility: ${label}`,
          meta: keyValue,
          sourceTable: 'facilities',
          displayColumn: 'facility_name',
          keyColumn: 'facility_id',
          keyValue,
          lookupColumn: 'facility_name',
          lookupValue: label,
          lookupKey: 'facility_id',
          transactionKey: 'facility_id',
          matchingKeys: [keyValue],
          transactionFilter: {
            column: 'facility_id',
            values: [keyValue],
            source: 'facilities.facility_name',
            label
          },
          postMergeFilter: {
            column: 'facility_name',
            operator: 'equals',
            value: label,
            source: 'facilities'
          },
          filterMode: 'lookup_resolved'
        });
      }
    });

    return Array.from(map.values()).sort(compareByLabel);
  }

  /*
    This function creates facility-status references and resolves each status to the matching facility ids.
    Those ids become transaction-table filters because facility status is not queried directly from the
    transaction table.
  */
  function buildFacilityStatusReferences(rows) {
    const statusMap = new Map();

    rows.forEach(row => {
      const value = cleanText(row.facility_status);
      const facilityId = cleanText(row.facility_id);
      if (!value || !facilityId) return;

      const key = value.toLowerCase();
      if (!statusMap.has(key)) statusMap.set(key, { label: value, facilityIds: [] });
      statusMap.get(key).facilityIds.push(facilityId);
    });

    return Array.from(statusMap.values()).map(entry => ({
      id: `ref_facility_status_${safeId(entry.label)}`,
      kind: 'reference',
      category: 'facilityStatus',
      label: entry.label,
      tokenLabel: `Facility Status: ${entry.label}`,
      meta: `${entry.facilityIds.length} Facilities`,
      sourceTable: 'facilities',
      lookupColumn: 'facility_status',
      lookupValue: entry.label,
      lookupKey: 'facility_id',
      transactionKey: 'facility_id',
      matchingKeys: uniqueValues(entry.facilityIds),
      transactionFilter: {
        column: 'facility_id',
        values: uniqueValues(entry.facilityIds),
        source: 'facilities.facility_status',
        label: entry.label
      },
      postMergeFilter: {
        column: 'facility_status',
        operator: 'equals',
        value: entry.label,
        source: 'facilities'
      },
      filterMode: 'lookup_resolved'
    })).sort(compareByLabel);
  }

  /*
    This function creates region and facility-type references from lookup data. It stores resolved facility ids
    so natural-language lookup filters can be applied safely to transaction SQL.
  */
  function buildLookupValueReferences(rows) {
    const mappings = [
      { column: 'facility_name', category: 'facility', label: 'Facility' },
      { column: 'facility_status', category: 'facilityStatus', label: 'Facility Status' },
      { column: 'facility_type', category: 'facilityType', label: 'Facility Type' },
      { column: 'region_name', category: 'facilityRegion', label: 'Facility Region' }
    ];

    return mappings.flatMap(mapping => {
      const grouped = new Map();

      rows.forEach(row => {
        const value = cleanText(row[mapping.column]);
        const facilityId = cleanText(row.facility_id);
        if (!value || !facilityId) return;

        const key = value.toLowerCase();
        if (!grouped.has(key)) grouped.set(key, { label: value, facilityIds: [] });
        grouped.get(key).facilityIds.push(facilityId);
      });

      return Array.from(grouped.values()).map(entry => ({
        id: `ref_${mapping.category}_${safeId(entry.label)}`,
        kind: 'reference',
        category: mapping.category,
        label: entry.label,
        tokenLabel: `${mapping.label}: ${entry.label}`,
        meta: `${entry.facilityIds.length} Facilities`,
        sourceTable: 'facilities',
        lookupColumn: mapping.column,
        lookupValue: entry.label,
        lookupKey: 'facility_id',
        transactionKey: 'facility_id',
        matchingKeys: uniqueValues(entry.facilityIds),
        transactionFilter: {
          column: 'facility_id',
          values: uniqueValues(entry.facilityIds),
          source: `facilities.${mapping.column}`,
          label: `${entry.label} ${mapping.label}`
        },
        postMergeFilter: {
          column: mapping.column,
          operator: 'equals',
          value: entry.label,
          source: 'facilities'
        },
        filterMode: 'lookup_resolved'
      }));
    });
  }


  /*
    This function converts metric catalog entries into selectable reference tokens. Each metric reference
    carries the calculation, alias, unit, and directionality used by the SQL generator or learned template.
  */
  function buildMetricReferences(metrics) {
    return metrics.map(metric => {
      const unitLabel = formatMetricUnit(metric.unit);
      return {
        ...metric,
        id: `metric_${safeId(metric.key || metric.name)}`,
        kind: 'metric',
        category: 'metrics',
        label: cleanText(metric.name),
        unitLabel,
        meta: [unitLabel, metric.directionality].filter(Boolean).join(' · ') || 'Metric',
        tokenLabel: `Metric: ${metric.name}${unitLabel ? ` (${unitLabel})` : ''}`,
        tooltip: buildMetricTooltip(metric, unitLabel)
      };
    }).sort(compareByLabel);
  }

  /*
    This function creates transaction-dimension references from a single transaction column. It supports
    dimensions such as robot class, shift, task, priority, failure reason, and source system.
  */
  function buildSingleColumnReferences(rows, categoryKey) {
    const cfg = state.config.categories[categoryKey];
    const map = new Map();

    rows.forEach(row => {
      const label = cleanText(row[cfg.primaryColumn]);
      if (!label) return;

      const key = label.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          id: `ref_${categoryKey}_${safeId(label)}`,
          kind: 'reference',
          category: categoryKey,
          label,
          tokenLabel: `${cfg.label}: ${label}`,
          meta: cfg.primaryColumn,
          sourceTable: 'transactions',
          sqlColumn: cfg.primaryColumn,
          sqlValue: label,
          filterMode: 'sql'
        });
      }
    });

    return Array.from(map.values()).sort(compareByLabel);
  }

  /*
    Reference panel, tab, and tier rendering.
  */

  /*
    This function enables or disables reference and playbook UI controls according to the active tier. Tier 1
    remains schema-only, while Tier 2 and Tier 3 can use references and Tier 3 can use playbooks.
  */
  function applyTierAvailability() {
    state.referencesDisabled = state.activeTier === 'tier1';
    state.playbooksDisabled = state.activeTier !== 'tier3';

    renderTierButtons();
    renderAvailabilityControls();
    renderReferences();
  }

  /*
    This function applies the current tier’s availability state to the reference panel and playbook button. It
    gives immediate visual feedback when a tier disables contextual resources.
  */
  function renderAvailabilityControls() {
    dom.referencesPanel.classList.toggle('is-disabled', state.referencesDisabled);
    dom.referenceSearch.disabled = state.referencesDisabled;
    dom.refreshReferencesButton.disabled = state.referencesDisabled || state.isBusy;
    dom.referenceTabs.forEach(button => { button.disabled = state.referencesDisabled || state.isBusy; });
    dom.playbooksButton.disabled = state.playbooksDisabled || state.isBusy;
  }

  /*
    This function renders the reference-category tab active states. It also disables tabs when the selected tier
    does not allow references.
  */
  function renderTabs() {
    dom.referenceTabs.forEach(button => {
      const isActive = button.dataset.category === state.activeCategory;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  /*
    This function renders the selected model-tier button state and accessibility attributes. It keeps the visual
    tier selection aligned with state.activeTier.
  */
  function renderTierButtons() {
    dom.modeButtons.forEach(button => {
      const isActive = button.dataset.tier === state.activeTier;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      button.disabled = state.isBusy;
    });
  }

  /*
    This function renders the filtered reference list for the active category. It rebuilds the list from state
    so the UI stays synchronized after search, refresh, or tier changes.
  */
  function renderReferences() {
    dom.referenceList.replaceChildren();

    if (state.referencesDisabled) {
      dom.referenceStatus.textContent = 'References Disabled For Tier 1';
      return;
    }

    const items = filterReferences(state.references[state.activeCategory] || []);
    dom.referenceStatus.textContent = items.length ? `${items.length} References Available` : 'No References Found';

    const fragment = document.createDocumentFragment();
    items.slice(0, 300).forEach(item => fragment.appendChild(createReferenceButton(item)));
    dom.referenceList.appendChild(fragment);
  }

  /*
    This function creates one clickable reference pill. The pill inserts a structured reference token into the
    composer when selected.
  */
  function createReferenceButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `reference-pill ${item.kind === 'metric' ? 'reference-pill--metric' : ''}`.trim();
    button.setAttribute('role', 'listitem');

    const tooltip = item.tooltip || buildReferenceTooltip(item);
    if (tooltip) {
      button.title = tooltip;
      button.setAttribute('aria-label', `${item.label}. ${tooltip}`);
    }

    const label = document.createElement('span');
    label.className = 'reference-pill__label';
    label.textContent = item.label;

    const meta = document.createElement('span');
    meta.className = 'reference-pill__meta';
    meta.textContent = item.meta || state.config.categories[item.category]?.label || 'Reference';

    button.append(label, meta);
    button.addEventListener('click', () => insertReferenceToken(item));
    return button;
  }

  /*
    This function filters reference items by the current search text. It uses normalized label and metadata text
    so users can search by display value or supporting context.
  */
  function filterReferences(items) {
    const query = state.searchText.trim().toLowerCase();
    if (!query) return items;
    return items.filter(item => `${item.label} ${item.meta || ''} ${item.description || ''}`.toLowerCase().includes(query));
  }

  /*
    Composer reference-token creation and caret management.
  */

  /*
    This function inserts or replaces a structured reference token in the composer. It keeps one active token
    per reference id and positions the caret after the inserted tag.
  */
  function insertReferenceToken(item) {
    if (state.referencesDisabled || state.isBusy) return;

    removeExistingReferenceToken(item.id);

    const token = createReferenceToken(item);
    const space = document.createTextNode(' ');
    const selection = window.getSelection();

    if (selection && selection.rangeCount && dom.composerInput.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(token);
      range.setStartAfter(space);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      dom.composerInput.append(token, space);
    }

    updateInsertedReferenceCount();
    placeCaretAtEnd(dom.composerInput);
    dom.composerInput.focus();
  }

  /*
    This function builds the contenteditable-safe span used to represent a selected reference. The token stores
    its category, id, label, and value in data attributes for later context extraction.
  */
  function createReferenceToken(item) {
    const token = document.createElement('span');
    token.className = `reference-token ${item.kind === 'metric' ? 'reference-token--metric' : ''}`.trim();
    token.contentEditable = 'false';
    token.dataset.refId = item.id;
    token.textContent = `[${item.tokenLabel}]`;

    const tooltip = item.tooltip || buildReferenceTooltip(item);
    if (tooltip) token.title = tooltip;

    return token;
  }

  /*
    This function removes an existing reference token from the composer by reference id. It prevents duplicate
    tags when a user inserts the same reference more than once.
  */
  function removeExistingReferenceToken(refId) {
    dom.composerInput.querySelectorAll('.reference-token').forEach(token => {
      if (token.dataset.refId === refId) token.remove();
    });
  }


  /*
    This function formats metric units for tooltips and labels. It provides a readable fallback when a metric
    has no explicit unit.
  */
  function formatMetricUnit(unit) {
    const value = cleanText(unit).toLowerCase();
    if (['min', 'mins', 'minute', 'minutes'].includes(value)) return 'minutes';
    if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(value)) return 'hours';
    return cleanText(unit);
  }

  /*
    This function builds the tooltip for a metric reference. It explains the metric description, calculation,
    unit, and directionality without adding clutter to the main reference list.
  */
  function buildMetricTooltip(metric, unitLabel = formatMetricUnit(metric.unit)) {
    const pieces = [
      cleanText(metric.description),
      unitLabel ? `Reported in ${unitLabel}.` : '',
      cleanText(metric.directionality) ? `A ${metric.directionality} value.` : ''
    ];

    return pieces.filter(Boolean).join(' ');
  }

  /*
    This function builds the tooltip for a non-metric reference. It summarizes the reference label, category,
    and source value used in model context.
  */
  function buildReferenceTooltip(item) {
    if (item.kind === 'metric') return item.tooltip || buildMetricTooltip(item);

    if (item.filterMode === 'post_merge') {
      return `Filters lookup-enriched results where ${item.lookupColumn} is ${item.lookupValue}. Matching transaction rows use ${item.transactionKey}.`;
    }

    if (item.sqlColumn && item.sqlValue) {
      return `Filters the transaction query where ${item.sqlColumn} is ${item.sqlValue}.`;
    }

    return cleanText(item.meta);
  }

  /*
    This function moves the text cursor to the end of a contenteditable element. It is used after programmatic
    token insertion so the user can keep typing naturally.
  */
  function placeCaretAtEnd(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /*
    This function counts active reference tokens in the composer and updates the visible counter. It gives the
    user a compact signal that exact context is attached.
  */
  function updateInsertedReferenceCount() {
    const count = dom.composerInput.querySelectorAll('.reference-token[data-ref-id]').length;
    dom.selectedReferenceCount.textContent = `${count} Reference${count === 1 ? '' : 's'} Inserted`;
  }

  /*
    Prompt submission, preflight context confirmation, and tiered execution.
  */

  /*
    This function starts the submit workflow for the active tier. It reads the prompt, performs the reference-
    tag gate first, and only continues when unresolved tag decisions are cleared.
  */
  async function runActiveTierWorkflow() {
    if (state.isBusy || state.pendingContextConfirmation) return;

    const prompt = readComposerText();
    if (!prompt) {
      appendErrorCard('Enter a prompt before sending.');
      return;
    }

    const composerSelections = extractComposerSelections();
    const detectionPrompt = readComposerText({ neutralMode: 'blank' });
    const implicitReferences = state.activeTier === 'tier1'
      ? []
      : detectImplicitReferences(detectionPrompt, [
        ...composerSelections.references,
        ...composerSelections.metrics
      ]);

    if (implicitReferences.length) {
      openContextConfirmationModal({
        confirmationKind: 'references',
        prompt,
        composerSelections,
        implicitReferences,
        playbookMatch: null,
        templateMatch: null
      });
      return;
    }

    await continueWorkflowAfterReferenceStage([]);
  }

  /*
    This function runs after reference-tag confirmation has either supplied confirmed references or found no
    pending reference work. It performs Tier 3 playbook/template planning before final submission.
  */
  async function continueWorkflowAfterReferenceStage(confirmedImplicitReferences = []) {
    const prompt = readComposerText();
    if (!prompt) {
      appendErrorCard('Enter a prompt before sending.');
      return;
    }

    const composerSelections = extractComposerSelections();
    const implicitReferences = normalizeList(confirmedImplicitReferences);

    if (state.activeTier !== 'tier3') {
      await submitConfirmedWorkflow(prompt, composerSelections, implicitReferences, {});
      return;
    }

    setBusy(true);
    setLlmGauge('neutral', 'LLM status: checking saved context');

    let matchPlan = null;
    try {
      matchPlan = await buildTier3MatchPlan(prompt, composerSelections, implicitReferences);
    } catch (error) {
      console.warn('[DEMO] Tier 3 match planning failed; continuing without saved pattern confirmation.', error);
      matchPlan = {
        prompt,
        composerSelections,
        implicitReferences,
        playbookMatch: null,
        templateMatch: null
      };
    } finally {
      setBusy(false);
      setLlmGauge('neutral', 'LLM status: idle');
    }

    if (matchPlan.playbookMatch) {
      openContextConfirmationModal({
        confirmationKind: 'playbook',
        prompt: matchPlan.prompt,
        composerSelections: matchPlan.composerSelections,
        implicitReferences: matchPlan.implicitReferences,
        playbookMatch: matchPlan.playbookMatch,
        templateMatch: null
      });
      return;
    }

    await submitConfirmedWorkflow(
      matchPlan.prompt,
      matchPlan.composerSelections,
      matchPlan.implicitReferences,
      {
        templateMatch: matchPlan.templateMatch,
        playbookMatch: null
      }
    );
  }

  /*
    This function builds the Tier 3 preflight plan. It checks for a confirmable playbook first and then finds
    any auto-reusable learned template that should be used without user confirmation.
  */
  async function buildTier3MatchPlan(prompt, composerSelections, confirmedImplicitReferences = []) {
    const plan = {
      prompt,
      composerSelections,
      implicitReferences: normalizeList(confirmedImplicitReferences),
      playbookMatch: null,
      templateMatch: null
    };

    if (state.activeTier !== 'tier3') return plan;

    await refreshTier3Caches();

    const playbookMatch = findPlaybookMatch(prompt);
    if (playbookMatch && !isReusableMatchDeclined(prompt, 'playbook', playbookMatch.playbook)) {
      plan.playbookMatch = playbookMatch;
      return plan;
    }

    const runtimeContext = buildTier2Context(prompt, composerSelections, plan.implicitReferences);
    const contextForTemplateMatching = enhanceContextWithTemplateTriggers(prompt, runtimeContext);
    const templateMatch = findTemplateMatch(prompt, contextForTemplateMatching);
    if (templateMatch) {
      plan.templateMatch = templateMatch;
    }

    return plan;
  }

  /*
    This function hands a fully confirmed prompt and context package into execution. It exists so modal
    confirmation can resume the same workflow without re-reading stale UI state.
  */
  async function submitConfirmedWorkflow(prompt, composerSelections, confirmedImplicitReferences, confirmedReusableMatches = {}) {
    addUserTurn(prompt);
    appendUserMessage(prompt);
    clearComposer();

    await executeSubmittedWorkflow(
      prompt,
      composerSelections,
      confirmedImplicitReferences,
      confirmedReusableMatches
    );
  }

  /*
    This function executes the selected tier after all preflight gates are clear. It gets schema, chooses
    reusable SQL when safe, calls the LLM when needed, runs SQL, enriches rows, renders results, and records
    chat memory.
  */
  async function executeSubmittedWorkflow(prompt, composerSelections, confirmedImplicitReferences, confirmedReusableMatches = {}) {
    setBusy(true);
    setLlmGauge('neutral', 'LLM status: resolving');

    const maxAttempts = getMaxSqlAttempts();
    const loadingCard = appendLoadingCard(formatAttemptLabel(1, maxAttempts, state.activeTier === 'tier1' ? 'Preparing Context...' : `Preparing ${state.activeTier.toUpperCase()} Context...`));
    reserveScrollSpace(loadingCard, 420);
    scrollOnceForSubmittedTurn(loadingCard, 420);

    try {
      const schema = await getTransactionSchema();
      let runtimeContext = state.activeTier === 'tier1'
        ? emptyTierContext()
        : buildTier2Context(prompt, composerSelections, confirmedImplicitReferences);
      let templateMatch = null;
      let playbookMatch = null;
      let runnablePlaybook = null;

      if (state.activeTier === 'tier3') {
        await refreshTier3Caches();
        runtimeContext = enhanceContextWithTemplateTriggers(prompt, runtimeContext);

        templateMatch = confirmedReusableMatches?.templateMatch || null;
        playbookMatch = confirmedReusableMatches?.playbookMatch || null;

        if (playbookMatch?.playbook) {
          runtimeContext = {
            ...runtimeContext,
            matchedPlaybook: compactPlaybookForModel(playbookMatch.playbook, playbookMatch.score)
          };
          runnablePlaybook = getRunnablePlaybook(playbookMatch.playbook);
        }
      }

      let result = null;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, 'Resolving Query Pattern...'));

          let tierResult = null;
          const reusablePattern = state.activeTier === 'tier3'
            ? (runnablePlaybook || templateMatch?.template || null)
            : null;

          if (reusablePattern) {
            const renderedSql = tryRenderReusablePattern(reusablePattern, prompt, runtimeContext, schema);
            if (renderedSql) {
              const isPlaybookPattern = reusablePattern.type === 'playbook';
              setLlmGauge('off', isPlaybookPattern ? 'No LLM: confirmed playbook matched' : 'No LLM: learned template matched');
              updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, `Using ${isPlaybookPattern ? 'Confirmed Playbook' : 'Learned Template'}: ${reusablePattern.title || 'Saved Pattern'}...`));
              tierResult = {
                sql: renderedSql,
                rows: [],
                rowCount: 0,
                model: isPlaybookPattern ? 'saved-playbook' : 'saved-pattern',
                fromTemplate: !isPlaybookPattern,
                fromPlaybook: isPlaybookPattern,
                template: isPlaybookPattern ? null : reusablePattern,
                playbook: isPlaybookPattern ? reusablePattern : null,
                templateScore: templateMatch?.score || playbookMatch?.score || null
              };
            }
          }

          if (!tierResult) {
            setLlmGauge('on', 'LLM active: generating SQL');
            updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, 'Writing Query...'));

            const tierResponse = state.activeTier === 'tier1'
              ? await callTier1Chat(schema)
              : await callTier2Chat(schema, runtimeContext);

            tierResult = normalizeTierResponse(tierResponse);
          }

          if (!tierResult.sql) throw new Error('The chat package did not return SQL.');

          updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, 'Querying Data...'));
          const executedRows = await executeSqlWithAttemptSql(tierResult.sql);

          updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, 'Preparing Results...'));
          const prepared = prepareRowsForDisplay(executedRows, runtimeContext);

          result = {
            ...tierResult,
            rows: prepared.rows,
            rowCount: prepared.rows.length,
            rawRowCount: executedRows.length,
            enrichment: prepared.enrichment,
            dateColumns: prepared.dateColumns,
            tier: state.activeTier,
            prompt,
            tierContext: runtimeContext,
            attemptsUsed: attempt,
            maxAttempts,
            feedback: ''
          };
          break;
        } catch (error) {
          lastError = error;
          console.warn(`[DEMO] SQL attempt ${attempt} of ${maxAttempts} failed:`, error);

          if (attempt < maxAttempts) {
            updateLoadingCard(loadingCard, formatAttemptLabel(attempt + 1, maxAttempts, 'Retrying From Last Successful Step...'));
            await wait(260);
          }
        }
      }

      if (!result) throw lastError || new Error('All SQL attempts failed.');

      state.lastResult = result;
      addAssistantTurn(`Results found: ${result.rowCount}. SQL: ${result.sql}`);
      replaceLoadingWithResult(loadingCard, result);
    } catch (error) {
      console.error('[DEMO] Chat workflow failed:', error);
      replaceLoadingWithError(loadingCard, `${state.activeTier.toUpperCase()} could not generate or execute a safe SQL query after ${getMaxSqlAttempts()} attempts.`);
    } finally {
      setBusy(false);
      setLlmGauge('neutral', 'LLM status: idle');
    }
  }

  /*
    In-app confirmation modal for matched reference tags and playbooks.
  */

  /*
    This function opens the in-app preflight modal for reference tags or playbook matches. It stores the pending
    decision so accepting continues execution and declining returns the user to the editable composer.
  */
  function openContextConfirmationModal(preflight) {
    if (!dom.contextConfirmOverlay) return;

    const kind = preflight?.confirmationKind === 'playbook' ? 'playbook' : 'references';
    state.pendingContextConfirmation = { ...preflight, confirmationKind: kind };

    const title = document.getElementById('contextConfirmTitle');
    const copy = dom.contextConfirmOverlay.querySelector('.context-confirm-card__copy');

    if (kind === 'playbook') {
      if (title) title.textContent = 'Confirm Matched Playbook';
      if (copy) {
        copy.textContent = normalizeList(preflight.implicitReferences).length
          ? 'DEMO found a possible playbook after applying confirmed tags. Use it, or return to the prompt to adjust the request.'
          : 'DEMO found a possible playbook for this prompt. Use it, or return to the prompt to adjust the request.';
      }
      if (dom.contextConfirmUseButton) dom.contextConfirmUseButton.textContent = 'Use Playbook';
    } else {
      if (title) title.textContent = 'Confirm Reference Tags';
      if (copy) copy.textContent = 'DEMO found possible reference tags before sending. Use them, or return to the prompt to adjust the request.';
      if (dom.contextConfirmUseButton) dom.contextConfirmUseButton.textContent = 'Use Reference Tags';
    }

    if (dom.contextConfirmEditButton) dom.contextConfirmEditButton.textContent = 'Edit Before Sending';

    dom.contextConfirmPrompt.textContent = clampForUi(preflight.prompt, 700);
    renderContextReferenceMatches(kind === 'references' ? preflight.implicitReferences : []);
    renderContextPatternMatches(kind === 'playbook' ? preflight : null);

    dom.contextConfirmOverlay.classList.remove('is-hidden');
    document.addEventListener('keydown', closeContextConfirmationOnEscape, true);

    window.setTimeout(() => {
      try { dom.contextConfirmEditButton?.focus(); } catch {}
    }, 0);
  }

  /*
    This function renders potential reference and metric tag matches inside the confirmation modal. It shows the
    user exactly which phrases would become structured context.
  */
  function renderContextReferenceMatches(implicitReferences) {
    const refs = normalizeList(implicitReferences);

    dom.contextConfirmReferencesSection.hidden = !refs.length;
    dom.contextConfirmReferencesCount.textContent = String(refs.length);
    dom.contextConfirmReferencesList.replaceChildren();

    refs.forEach(ref => {
      const chip = document.createElement('span');
      chip.className = 'context-confirm-chip';
      chip.textContent = `${getReferenceCategoryLabel(ref)}: ${ref.label}`;
      dom.contextConfirmReferencesList.appendChild(chip);
    });
  }

  /*
    This function renders the confirmable playbook match inside the confirmation modal. Learned templates are
    intentionally not rendered here because they are selected automatically after the user-visible gates are
    clear.
  */
  function renderContextPatternMatches(preflight) {
    const match = preflight?.playbookMatch
      ? { kind: 'Playbook', score: preflight.playbookMatch.score, item: preflight.playbookMatch.playbook }
      : null;

    dom.contextConfirmPatternSection.hidden = !match;
    dom.contextConfirmPatternScore.textContent = match ? `Score ${Number(match.score) || 0}` : '—';
    dom.contextConfirmPatternList.replaceChildren();

    if (!match) return;

    const row = document.createElement('article');
    row.className = 'context-confirm-pattern';

    const title = document.createElement('div');
    title.className = 'context-confirm-pattern__title';
    title.textContent = match.item?.title || 'Saved Playbook';

    const meta = document.createElement('div');
    meta.className = 'context-confirm-pattern__meta';
    meta.textContent = `${match.kind} match · score ${match.score}`;

    const desc = document.createElement('p');
    desc.textContent = match.item?.description || match.item?.promptTemplate || 'Saved Tier 3 playbook.';

    row.append(title, meta, desc);
    dom.contextConfirmPatternList.appendChild(row);
  }

  /*
    This function resolves the user’s modal choice. Accepting applies tags or continues with a playbook, while
    declining neutralizes reference phrases or remembers declined playbooks and returns focus to editing.
  */
  function resolveContextConfirmation(accepted) {
    const pending = state.pendingContextConfirmation;
    if (!pending || state.isBusy) return;

    closeContextConfirmationModal();

    if (pending.confirmationKind === 'references') {
      if (accepted) {
        applyConfirmedReferencesToComposer(pending.implicitReferences);
        focusComposerForEditing();
        return;
      }

      neutralizeImplicitReferencesInComposer(pending.implicitReferences);
      focusComposerForEditing();
      return;
    }

    if (pending.confirmationKind === 'playbook') {
      if (accepted) {
        submitConfirmedWorkflow(
          pending.prompt,
          pending.composerSelections,
          pending.implicitReferences,
          {
            templateMatch: null,
            playbookMatch: pending.playbookMatch
          }
        ).catch(error => {
          console.error('[DEMO] Confirmed playbook workflow failed:', error);
          appendErrorCard('DEMO could not continue after confirming the playbook.');
          setBusy(false);
          setLlmGauge('neutral', 'LLM status: idle');
        });
        return;
      }

      rememberDeclinedReusableMatches(pending);
      focusComposerForEditing();
    }
  }

  /*
    This function closes and clears the context confirmation modal. It removes the escape-key listener and
    resets the pending confirmation state.
  */
  function closeContextConfirmationModal() {
    if (!state.pendingContextConfirmation && dom.contextConfirmOverlay?.classList.contains('is-hidden')) return;

    state.pendingContextConfirmation = null;
    dom.contextConfirmOverlay?.classList.add('is-hidden');
    document.removeEventListener('keydown', closeContextConfirmationOnEscape, true);
  }

  /*
    This function lets the Escape key decline the active context confirmation. It mirrors the edit-before-
    sending path so no query is submitted by accident.
  */
  function closeContextConfirmationOnEscape(event) {
    if (event.key !== 'Escape') return;
    if (!state.pendingContextConfirmation) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    resolveContextConfirmation(false);
  }

  /*
    This function records declined reusable pattern signatures for the current prompt. It prevents the same
    unchanged playbook suggestion from reappearing immediately after a user declines it.
  */
  function rememberDeclinedReusableMatches(preflight) {
    if (!preflight?.playbookMatch) return;
    state.declinedReusableSignatures.add(buildReusableMatchSignature(preflight.prompt, 'playbook', preflight.playbookMatch.playbook));
  }

  /*
    This function checks whether a reusable match was already declined for the current prompt text. It allows
    prompt edits to re-enable matching because the signature changes with the prompt.
  */
  function isReusableMatchDeclined(prompt, kind, item) {
    return state.declinedReusableSignatures.has(buildReusableMatchSignature(prompt, kind, item));
  }

  /*
    This function builds the stable signature used to remember a declined playbook or template candidate. It
    combines normalized prompt text with the match kind and id-like fields.
  */
  function buildReusableMatchSignature(prompt, kind, item) {
    const itemKey = cleanText(item?.id || item?.__appDbId || item?.title || item?.promptTemplate || kind);
    return `${kind}:${normalizePhrase(prompt)}:${normalizePhrase(itemKey)}`;
  }

  /*
    This function inserts every confirmed implicit reference into the composer as a visible token. Solving one
    reference applies it consistently to all matching occurrences of the same reference kind and phrase.
  */
  function applyConfirmedReferencesToComposer(implicitReferences) {
    const refs = dedupeBySignature(normalizeList(implicitReferences), referenceSignature)
      .sort((a, b) => cleanText(b.label).length - cleanText(a.label).length);

    refs.forEach(ref => tokenizeReferencePhrase(ref));
    updateInsertedReferenceCount();
  }

  /*
    This function converts a matched reference phrase into a visible reference token. It uses the existing
    reference object when possible so stored data attributes remain consistent.
  */
  function tokenizeReferencePhrase(ref) {
    const phrases = getReferenceMatchPhrases(ref);
    if (!phrases.length || !dom.composerInput) return false;

    removeExistingReferenceToken(ref.id);

    let inserted = false;
    phrases.forEach(phrase => {
      let safety = 0;
      let match = findTextMatchOutsideReferenceTokens(phrase);

      while (match && safety < 40) {
        const token = createReferenceToken(ref);
        const range = document.createRange();
        range.setStart(match.node, match.start);
        range.setEnd(match.node, match.end);
        range.deleteContents();
        range.insertNode(token);

        inserted = true;
        safety += 1;
        match = findTextMatchOutsideReferenceTokens(phrase);
      }
    });

    if (!inserted) {
      dom.composerInput.append(document.createTextNode(' '), createReferenceToken(ref), document.createTextNode(' '));
      inserted = true;
    }

    return inserted;
  }

  /*
    This function marks declined implicit reference phrases as neutral tokens. Neutral tokens remain visible as
    ordinary text intent while being skipped by future tag scans until the user changes the wording.
  */
  function neutralizeImplicitReferencesInComposer(implicitReferences) {
    const refs = dedupeBySignature(normalizeList(implicitReferences), referenceSignature)
      .sort((a, b) => cleanText(b.label).length - cleanText(a.label).length);

    refs.forEach(ref => neutralizeReferencePhrase(ref));
    updateInsertedReferenceCount();
  }

  /*
    This function neutralizes all matching occurrences of one declined reference phrase. It supports the rule
    that a solved reference decision applies to other entries of the same kind in that position.
  */
  function neutralizeReferencePhrase(ref) {
    const phrases = getReferenceMatchPhrases(ref);
    if (!phrases.length || !dom.composerInput) return false;

    let neutralized = false;

    phrases.forEach(phrase => {
      let safety = 0;
      let match = findTextMatchOutsideReferenceTokens(phrase);

      while (match && safety < 40) {
        const token = createNeutralReferenceToken(ref, phrase);
        const range = document.createRange();
        range.setStart(match.node, match.start);
        range.setEnd(match.node, match.end);
        range.deleteContents();
        range.insertNode(token);

        neutralized = true;
        safety += 1;
        match = findTextMatchOutsideReferenceTokens(phrase);
      }
    });

    return neutralized;
  }

  /*
    This function creates a neutral inline token for declined reference text. The token preserves the words
    while telling the scanner not to treat them as active reference candidates.
  */
  function createNeutralReferenceToken(ref, phrase) {
    const token = document.createElement('span');
    token.className = 'reference-token reference-token--neutral';
    token.contentEditable = 'false';
    token.dataset.neutralPhrase = phrase;
    token.dataset.neutralRefKey = referenceSignature(ref);
    token.textContent = `[${phrase}]`;
    token.title = 'Marked neutral. DEMO will not treat this phrase as a reference tag.';
    return token;
  }

  /*
    This function finds a text phrase inside the composer while ignoring existing reference-token elements. It
    protects active tags from being split or rewritten by neutralization.
  */
  function findTextMatchOutsideReferenceTokens(phrase) {
    const walker = document.createTreeWalker(
      dom.composerInput,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest('.reference-token')) return NodeFilter.FILTER_REJECT;
          return cleanText(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    let node = walker.nextNode();
    while (node) {
      const span = findPhraseWindow(node.nodeValue, phrase);
      if (span) return { node, start: span.start, end: span.end };
      node = walker.nextNode();
    }

    return null;
  }

  /*
    This function locates a phrase in normalized text and maps it back to raw text offsets. It supports robust
    phrase replacement even when user spacing differs from reference spacing.
  */
  function findPhraseWindow(text, phrase) {
    const source = String(text || '');
    const cleanedPhrase = cleanText(phrase);
    if (!source || !cleanedPhrase) return null;

    const boundary = '[^A-Za-z0-9_]';
    const pattern = new RegExp(`(^|${boundary})(${escapeRegExp(cleanedPhrase)})(?=$|${boundary})`, 'i');
    const match = source.match(pattern);
    if (match) {
      const start = match.index + match[1].length;
      return { start, end: start + match[2].length };
    }

    const direct = source.toLowerCase().indexOf(cleanedPhrase.toLowerCase());
    return direct >= 0 ? { start: direct, end: direct + cleanedPhrase.length } : null;
  }

  /*
    This function collapses the workflow back to the editable composer. It is used after declined context so the
    user can alter the request before resubmitting.
  */
  function focusComposerForEditing() {
    requestAnimationFrame(() => {
      placeCaretAtEnd(dom.composerInput);
      dom.composerInput.focus();
      dom.composerInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

    /*
      This function returns the display label for a reference category. It provides stable modal labels even when
      category metadata is missing.
    */
    function getReferenceCategoryLabel(ref) {
    return state.config.categories[ref.category]?.label || ref.category || 'Reference';
  }

  /*
    This function shortens long UI text without changing the underlying data. It keeps modal rows and cards
    readable when prompts or descriptions are lengthy.
  */
  function clampForUi(value, maxLength) {
    const text = cleanText(value);
    const max = Number(maxLength) || 500;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }


  /*
    General workflow utilities and LLM status feedback.
  */

  /*
    This function returns the configured number of SQL-generation attempts. It enforces at least one attempt and
    delegates numeric bounds to normalizeMaxRows-like logic.
  */
  function getMaxSqlAttempts() {
    const attempts = Number(state.config.maxSqlAttempts);
    return Math.max(1, Math.min(3, Number.isFinite(attempts) ? Math.floor(attempts) : 3));
  }

  /*
    This function formats the user-facing loading label for SQL-generation attempts. It makes retry activity
    visible without exposing raw technical errors.
  */
  function formatAttemptLabel(attempt, maxAttempts, label) {
    return `Attempt ${attempt} of ${maxAttempts}. ${label}`;
  }

  /*
    This function pauses execution for a small number of milliseconds. It is used between retries to avoid rapid
    repeated package calls.
  */
  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  /*
    This function updates the visible LLM status gauge. It distinguishes idle, resolving, working, skipped, and
    error states for operator trust.
  */
  function setLlmGauge(mode, title) {
    if (!dom.llmStatusGauge || !dom.llmStatusText) return;

    const safeMode = ['on', 'off', 'neutral'].includes(mode) ? mode : 'neutral';
    dom.llmStatusGauge.classList.remove('is-on', 'is-off', 'is-neutral');
    dom.llmStatusGauge.classList.add(`is-${safeMode}`);

    const labels = {
      on: 'LLM On',
      off: 'LLM Off',
      neutral: 'LLM Idle'
    };

    dom.llmStatusText.textContent = labels[safeMode];
    dom.llmStatusGauge.title = title || labels[safeMode];
    dom.llmStatusGauge.setAttribute('aria-label', dom.llmStatusGauge.title);
  }

  /*
    Context enrichment from saved template trigger maps.
  */

  /*
    This function applies the trigger map from a matched reusable template to the runtime context. It lets saved
    templates restore resolved filters, metrics, and dimensions before SQL rendering.
  */
  function enhanceContextWithTemplateTriggers(prompt, context) {
    const next = cloneJson(context || emptyTierContext());

    state.templates.forEach(template => {
      applyTriggerMapToContext(template.triggerMap, prompt, next);
    });

    next.selectedReferences = dedupeBySignature(next.selectedReferences || [], ref => {
      return `${ref.category || ''}:${ref.sqlColumn || ref.lookupColumn || ''}:${ref.sqlValue || ref.lookupValue || ref.label}`;
    });

    next.selectedMetrics = dedupeBySignature(next.selectedMetrics || [], metric => metric.key || metric.name);
    next.transactionFilters = dedupeFilters(next.transactionFilters || []);
    next.postMergeFilters = dedupePostMergeFilters(next.postMergeFilters || []);

    return next;
  }

  /*
    This function merges matching trigger-map entries into the active Tier 2 context. It only applies triggers
    that match the current prompt so stale saved context is not blindly reused.
  */
  function applyTriggerMapToContext(triggerMap, prompt, context) {
    if (!triggerMap) return;

    normalizeList(triggerMap.metrics).forEach(trigger => {
      if (!triggerMatchesPrompt(trigger, prompt)) return;
      const metric = state.metricsCatalog.find(item => item.key === trigger.metricKey);
      if (metric) context.selectedMetrics.push(metric);
    });

    normalizeList(triggerMap.dimensions).forEach(trigger => {
      if (!dimensionTriggerMatchesPrompt(trigger, prompt)) return;
      if (!Array.isArray(context.breakdownColumns)) context.breakdownColumns = [];
      if (trigger.column) context.breakdownColumns.push(trigger.column);
    });

    normalizeList(triggerMap.lookupFilters).forEach(trigger => {
      if (!triggerMatchesPrompt(trigger, prompt)) return;

      const ref = findLookupReference(trigger.lookupColumn, trigger.lookupValue);
      if (ref) {
        context.selectedReferences.push(ref);
        if (ref.transactionFilter) context.transactionFilters.push(ref.transactionFilter);
        if (ref.postMergeFilter) context.postMergeFilters.push(ref.postMergeFilter);
      }
    });

    normalizeList(triggerMap.transactionFilters).forEach(trigger => {
      if (!triggerMatchesPrompt(trigger, prompt)) return;

      const ref = findTransactionReference(trigger.column, trigger.value);
      if (ref) {
        context.selectedReferences.push(ref);
        context.transactionFilters.push({
          column: ref.sqlColumn,
          values: [ref.sqlValue],
          source: ref.sourceTable || 'transactions',
          label: ref.label
        });
      } else if (trigger.column && trigger.value) {
        context.transactionFilters.push({
          column: trigger.column,
          values: [trigger.value],
          source: trigger.source || 'transactions',
          label: trigger.value
        });
      }
    });
  }


  /*
    This function determines whether a saved trigger phrase appears in the current prompt. It uses normalized
    phrase matching to support slight spacing and case differences.
  */
  function triggerMatchesPrompt(trigger, prompt) {
    const text = normalizePhrase(prompt);
    return normalizeList(trigger.phrases).some(phrase => {
      const normalized = normalizePhrase(phrase);
      return normalized && new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i').test(text);
    });
  }

  /*
    This function finds a lookup-based reference by column and value. It is used when saved template triggers
    need to restore facility, region, status, or type context.
  */
  function findLookupReference(column, value) {
    const lookupColumn = cleanText(column).toLowerCase();
    const lookupValue = cleanText(value).toLowerCase();

    return state.lookupReferenceIndex.find(item => {
      return cleanText(item.lookupColumn).toLowerCase() === lookupColumn
        && cleanText(item.lookupValue).toLowerCase() === lookupValue;
    }) || null;
  }

  /*
    This function finds a transaction-column reference by column and value. It is used when saved template
    triggers need to restore filters such as shift, robot class, task, or source system.
  */
  function findTransactionReference(column, value) {
    const sqlColumn = cleanText(column).toLowerCase();
    const sqlValue = cleanText(value).toLowerCase();

    return Object.values(state.references).flat().find(item => {
      return cleanText(item.sqlColumn).toLowerCase() === sqlColumn
        && cleanText(item.sqlValue).toLowerCase() === sqlValue;
    }) || null;
  }


  /*
    Reusable saved-pattern SQL rendering and validation.
  */

  /*
    This function extracts a runnable SQL template from a playbook when one exists. It lets a confirmed playbook
    bypass the LLM only when the saved SQL pattern can be safely rendered.
  */
  function getRunnablePlaybook(playbook) {
    if (!playbook || !playbook.sqlTemplate) return null;
    return {
      ...playbook,
      type: 'playbook',
      intentSignature: playbook.intentSignature || {},
      matchPhrases: playbook.matchPhrases || [playbook.title, playbook.description, playbook.promptTemplate].filter(Boolean)
    };
  }

  /*
    This function attempts to render a learned template or confirmed playbook into executable SQL. It returns
    null when rendering or validation fails so the workflow can safely fall back to the LLM.
  */
  function tryRenderReusablePattern(pattern, prompt, tierContext, schema) {
    try {
      const sql = renderTemplateSql(pattern, prompt, tierContext);
      validateRenderedTemplateSql(sql, schema);
      return sql;
    } catch (error) {
      console.warn('[DEMO] Saved pattern could not be safely reused:', error);
      return '';
    }
  }

  /*
    This function enforces the same single-table safety rules on rendered reusable SQL that the app expects from
    LLM-generated SQL. It blocks semicolons, joins, subqueries, unsafe keywords, and unknown columns.
  */
  function validateRenderedTemplateSql(sqlRaw, schema) {
    const sql = cleanText(sqlRaw);

    if (!/^select\b/i.test(sql)) throw new Error('Saved pattern SQL must start with SELECT.');
    if (/[;]/.test(sql)) throw new Error('Saved pattern SQL must not contain semicolons.');
    if (/--|\/\*|\*\//.test(sql)) throw new Error('Saved pattern SQL must not contain comments.');
    if (!/\bfrom\s+table\s+(?:as\s+)?o\b/i.test(sql)) throw new Error('Saved pattern SQL must use FROM table o.');
    if (/\bo\.(facility_name|facility_status|facility_type|region_name)\b/i.test(sql)) {
      throw new Error('Saved pattern SQL must use facility_id for lookup-derived facility fields.');
    }
    if (/\{\{[^}]+\}\}/.test(sql)) throw new Error('Saved pattern still has unresolved slots.');

    const banned = /\b(join|with|union|intersect|except|insert|update|delete|merge|create|drop|alter|grant|revoke|truncate|call|exec|execute)\b/i;
    if (banned.test(sql)) throw new Error('Saved pattern SQL contains a disallowed keyword.');

    if (/\bfrom\s*\(|\(\s*select\b/i.test(sql)) {
      throw new Error('Saved pattern SQL must not contain subqueries or derived tables.');
    }

    const allowed = new Set(extractSchemaColumnNames(schema).map(name => cleanText(name).toLowerCase()));
    const references = sql.match(/\bo\.([A-Za-z_][A-Za-z0-9_]*)\b/g) || [];

    for (const ref of references) {
      const col = ref.slice(2).toLowerCase();
      if (!allowed.has(col)) throw new Error(`Saved pattern references a missing column: ${col}`);
    }
  }


  /*
    This function extracts a set of valid column names from the schema package response. It supports SQL
    validation regardless of which schema response shape Domo returns.
  */
  function extractSchemaColumnNames(schemaRaw) {
    let schema = schemaRaw;

    if (typeof schemaRaw === 'string') {
      try {
        schema = JSON.parse(schemaRaw);
      } catch {
        schema = null;
      }
    }

    const candidates = [
      schema?.columns,
      schema?.tables?.[0]?.columns,
      schema?.firstMatch?.columns,
      schema?.firstMatch?.tables?.[0]?.columns,
      schema?.response?.columns,
      schema?.response?.tables?.[0]?.columns,
      schema?.schema?.columns,
      schema?.schema?.tables?.[0]?.columns,
      Array.isArray(schema) ? schema : null
    ].filter(Array.isArray);

    return (candidates[0] || [])
      .map(col => cleanText(col.name ?? col.column ?? col.columnName ?? col.id))
      .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .filter(name => !name.startsWith('_BATCH_'));
  }

  /*
    This function deep-clones JSON-compatible values. It prevents stored templates, playbooks, and context
    objects from being mutated accidentally during rendering.
  */
  function cloneJson(value) {
    try {
      return JSON.parse(JSON.stringify(value || {}));
    } catch {
      return {};
    }
  }

  /*
    Tier 2 and Tier 3 context construction for Code Engine calls.
  */

  /*
    This function creates a blank Tier 2 context object. It gives all downstream model and template logic the
    same arrays and optional fields even when no references are selected.
  */
  function emptyTierContext() {
    return {
      selectedReferences: [],
      selectedMetrics: [],
      transactionFilters: [],
      postMergeFilters: [],
      breakdownColumns: [],
      lookupMappings: state.config.lookupMappings
    };
  }

  /*
    This function builds the full model context from explicit composer tokens, confirmed implicit references,
    metrics, lookup mappings, and filter candidates. It is the main bridge between user language and SQL-
    generation inputs.
  */
  function buildTier2Context(prompt, composerSelections = null, confirmedImplicitReferences = null) {
    const explicit = composerSelections || extractComposerSelections();
    const explicitResolved = [
      ...normalizeList(explicit.references),
      ...normalizeList(explicit.metrics)
    ];

    const confirmed = Array.isArray(confirmedImplicitReferences)
      ? normalizeList(confirmedImplicitReferences)
      : detectImplicitReferences(prompt, explicitResolved);

    const confirmedMetricRefs = confirmed.filter(item => item?.kind === 'metric');
    const confirmedReferenceRefs = confirmed.filter(item => item?.kind !== 'metric');

    const implicitMetrics = dedupeBySignature([
      ...confirmedMetricRefs,
      ...detectImplicitMetrics(prompt)
    ], item => item.key || item.name);

    const selectedReferences = dedupeBySignature([...explicit.references, ...confirmedReferenceRefs], item => {
      return `${item.category || ''}:${item.sqlColumn || item.lookupColumn || ''}:${item.sqlValue || item.lookupValue || item.label}`;
    });

    const selectedMetrics = dedupeBySignature([...explicit.metrics, ...implicitMetrics], item => item.key || item.name);
    const breakdownColumns = extractBreakdownColumns(prompt);

    const transactionFilters = [];
    const postMergeFilters = [];

    selectedReferences.forEach(ref => {
      if (ref.transactionFilter) transactionFilters.push(ref.transactionFilter);
      if (ref.postMergeFilter) postMergeFilters.push(ref.postMergeFilter);
      if (ref.sqlColumn && ref.sqlValue) {
        transactionFilters.push({
          column: ref.sqlColumn,
          values: [ref.sqlValue],
          source: ref.sourceTable || 'transactions',
          label: ref.label
        });
      }
    });

    return {
      selectedReferences: selectedReferences.map(compactReferenceForModel),
      selectedMetrics: selectedMetrics.map(compactMetricForModel),
      transactionFilters: dedupeFilters(transactionFilters),
      postMergeFilters: dedupePostMergeFilters(postMergeFilters),
      breakdownColumns,
      lookupMappings: state.config.lookupMappings
    };
  }

  /*
    This function reads structured reference tokens from the composer. It turns visible tags back into reference
    objects before the prompt is submitted.
  */
  function extractComposerSelections() {
    const tokens = Array.from(dom.composerInput.querySelectorAll('.reference-token'));
    const references = [];
    const metrics = [];

    tokens.forEach(token => {
      const item = state.referenceById.get(token.dataset.refId);
      if (!item) return;
      if (item.kind === 'metric') metrics.push(item);
      else references.push(item);
    });

    return { references, metrics };
  }

  /*
    Natural-language reference and metric detection.
  */

  /*
    This function scans the plain prompt for reference values that were not explicitly tagged. It checks lookup
    references, transaction references, and metric references while skipping already selected or neutralized
    entries.
  */
  function detectImplicitReferences(prompt, explicitReferences = []) {
    const explicitKeys = new Set(normalizeList(explicitReferences).map(ref => referenceSignature(ref)));
    const candidates = [
      ...detectImplicitMetrics(prompt),
      ...detectImplicitLookupReferences(prompt),
      ...detectImplicitTransactionReferences(prompt)
    ];

    return dedupeBySignature(candidates, referenceSignature)
      .filter(ref => !explicitKeys.has(referenceSignature(ref)));
  }

  /*
    This function finds facility lookup phrases in natural language. It supports facility names, facility
    statuses, regions, and facility types that should resolve to transaction-table facility ids.
  */
  function detectImplicitLookupReferences(prompt) {
    if (state.activeTier === 'tier1') return [];

    const text = normalizePhrase(prompt);
    const refs = [];
    const facilityHint = /\b(facility|facilities|site|sites|dc|dcs|node|nodes|region|regions|type|status|warehouse|warehouses|location|locations)\b/i.test(prompt);
    const restrictiveHint = /\b(only|just|filter|filtered|include|including|for|show|report|where|within|in|from)\b/i.test(prompt);

    state.lookupReferenceIndex.forEach(item => {
      const phrases = getReferenceMatchPhrases(item);
      const matchedPhrases = phrases.filter(phrase => phraseMatchesTextWindow(text, phrase));
      if (matchedPhrases.length && (facilityHint || restrictiveHint)) refs.push({ ...item, matchedPhrases, matchedPhrase: matchedPhrases[0] });
    });

    return dedupeBySignature(refs, item => `${item.lookupColumn}:${item.lookupValue}`);
  }

  /*
    This function finds transaction-dimension phrases in natural language. It supports dimensions such as robot
    class, shift, task, task status, priority, failure reason, and source system.
  */
  function detectImplicitTransactionReferences(prompt) {
    if (state.activeTier === 'tier1') return [];

    const text = normalizePhrase(prompt);
    const categories = ['robotClass', 'shift', 'task', 'taskStatus', 'priority', 'failureReason', 'sourceSystem'];
    const refs = [];

    categories.forEach(category => {
      normalizeList(state.references[category]).forEach(item => {
        const phrases = getReferenceMatchPhrases(item);
        const matchedPhrases = phrases.filter(phrase => phraseMatchesTextWindow(text, phrase));
        if (matchedPhrases.length) refs.push({ ...item, matchedPhrases, matchedPhrase: matchedPhrases[0] });
      });
    });

    return dedupeBySignature(refs, referenceSignature);
  }

  /*
    This function finds metric names and aliases in natural language. It lets phrases such as Bot Burden and
    Charge Choke enter the same confirmation flow as other reference tags.
  */
  function detectImplicitMetrics(prompt) {
    if (state.activeTier === 'tier1') return [];

    const text = normalizePhrase(prompt);
    return state.metricsCatalog.map(metric => {
      const phrases = metricReferencePhrases(metric);
      const matchedPhrases = phrases.filter(phrase => phraseMatchesTextWindow(text, phrase));
      if (!matchedPhrases.length) return null;

      const unitLabel = formatMetricUnit(metric.unit);
      return {
        ...metric,
        id: `metric_${safeId(metric.key || metric.name)}`,
        kind: 'metric',
        category: 'metrics',
        label: cleanText(metric.name),
        tokenLabel: `Metric: ${metric.name}${unitLabel ? ` (${unitLabel})` : ''}`,
        matchedPhrases,
        matchedPhrase: matchedPhrases[0],
        unitLabel,
        tooltip: metric.tooltip || buildMetricTooltip(metric, unitLabel)
      };
    }).filter(Boolean);
  }

  /*
    This function returns every phrase that can identify a metric. It combines the metric name, key, aliases,
    default alias, and compact variants for broader natural-language coverage.
  */
  function metricReferencePhrases(metric) {
    const base = [
      metric.name,
      metric.key,
      ...(metric.aliases || [])
    ].map(cleanText).filter(Boolean);

    const derived = base.flatMap(phrase => {
      const normalized = phrase.replace(/_/g, ' ');
      return [
        normalized,
        normalized.replace(/\bbot\b/gi, 'robot'),
        normalized.replace(/\brobot\b/gi, 'bot'),
        normalized.replace(/\bcharge\b/gi, 'charging'),
        normalized.replace(/\bcharging\b/gi, 'charge')
      ];
    });

    return dedupeBySignature(derived, phrase => normalizePhrase(phrase))
      .filter(phrase => normalizePhrase(phrase).length >= 3)
      .sort((left, right) => cleanText(right).length - cleanText(left).length);
  }

  /*
    This function tests whether a phrase appears as a meaningful window inside normalized prompt text. It
    prevents small metric or reference words from matching unrelated substrings.
  */
  function phraseMatchesTextWindow(normalizedText, phrase) {
    const text = normalizeLoosePhrase(normalizedText);
    const normalizedPhrase = normalizeLoosePhrase(phrase);
    if (!text || !normalizedPhrase) return false;
    return new RegExp(`\\b${escapeRegExp(normalizedPhrase)}\\b`, 'i').test(text);
  }

  /*
    This function normalizes a phrase for forgiving natural-language comparisons. It removes bracketed tag
    syntax, punctuation noise, and repeated whitespace.
  */
  function normalizeLoosePhrase(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /*
    This function creates a stable deduplication signature for a reference. It prevents the same reference from
    being confirmed, inserted, or modeled multiple times.
  */
  function referenceSignature(ref) {
    return `${ref.category || ''}:${ref.sqlColumn || ref.lookupColumn || ref.key || ''}:${ref.sqlValue || ref.lookupValue || ref.label || ref.name}`;
  }

  /*
    This function returns the phrases that identify a reference in text. It uses matchPhrases when available and
    falls back to label, value, and metadata fields.
  */
  function getReferenceMatchPhrases(ref) {
    const phrases = [
      ref?.matchedPhrase,
      ...normalizeList(ref?.matchedPhrases),
      ref?.label,
      ref?.lookupValue,
      ref?.sqlValue,
      ref?.name
    ].map(cleanText).filter(Boolean);

    if (ref?.kind === 'metric') phrases.push(...metricReferencePhrases(ref));

    return dedupeBySignature(phrases, phrase => normalizePhrase(phrase))
      .filter(phrase => normalizePhrase(phrase).length >= 2)
      .sort((left, right) => cleanText(right).length - cleanText(left).length);
  }

  /*
    This function reduces a reference object to the fields useful for Code Engine. It keeps selected context
    small and avoids sending unnecessary UI-only data.
  */
  function compactReferenceForModel(ref) {
    return {
      category: ref.category,
      label: ref.label,
      sourceTable: ref.sourceTable,
      sqlColumn: ref.sqlColumn,
      sqlValue: ref.sqlValue,
      lookupColumn: ref.lookupColumn,
      lookupValue: ref.lookupValue,
      lookupKey: ref.lookupKey,
      transactionKey: ref.transactionKey,
      matchingKeys: ref.matchingKeys,
      transactionFilter: ref.transactionFilter,
      postMergeFilter: ref.postMergeFilter,
      filterMode: ref.filterMode
    };
  }

  /*
    This function reduces a metric reference to the fields needed for SQL generation. It preserves calculation,
    alias, unit, directionality, and date-column metadata.
  */
  function compactMetricForModel(metric) {
    return {
      key: metric.key,
      name: metric.name,
      aliases: metric.aliases,
      description: metric.description,
      calculation: metric.calculation,
      defaultAlias: metric.defaultAlias,
      unit: metric.unit,
      directionality: metric.directionality,
      dateColumn: metric.dateColumn
    };
  }

  /*
    This function merges duplicate transaction filters by column. It combines values while keeping the model
    context compact and deterministic.
  */
  function dedupeFilters(filters) {
    const merged = new Map();

    filters.forEach(filter => {
      const column = cleanText(filter.column);
      const values = uniqueValues(filter.values || []);
      if (!column || !values.length) return;

      const key = `${column}:${cleanText(filter.source)}:${cleanText(filter.label)}`;
      if (!merged.has(key)) merged.set(key, { ...filter, column, values: [] });
      merged.get(key).values = uniqueValues([...merged.get(key).values, ...values]);
    });

    return Array.from(merged.values());
  }

  /*
    This function removes duplicate post-merge filters after lookup enrichment. It protects result filtering
    from repeated equivalent lookup conditions.
  */
  function dedupePostMergeFilters(filters) {
    return dedupeBySignature(filters, filter => `${filter.column}:${filter.operator}:${filter.value}`);
  }

  /*
    This function deduplicates any list using a caller-supplied signature function. It preserves insertion order
    so explicit user choices stay ahead of inferred context.
  */
  function dedupeBySignature(items, signatureFn) {
    const map = new Map();
    items.forEach(item => {
      const key = signatureFn(item);
      if (key && !map.has(key)) map.set(key, item);
    });
    return Array.from(map.values());
  }

  /*
    Result enrichment, post-merge filtering, and date-grain detection.
  */

  /*
    This function prepares executed SQL rows for display. It enriches facility ids with lookup details, applies
    lookup-only filters, and annotates detected date columns.
  */
  function prepareRowsForDisplay(rows, tierContext) {
    const enriched = enrichRowsWithFacilityLookup(rows, tierContext.postMergeFilters || []);
    const filtered = applyPostMergeFilters(enriched.rows, tierContext.postMergeFilters || []);
    const dateColumns = detectDateColumns(filtered.rows);

    return {
      rows: filtered.rows,
      enrichment: {
        ...enriched.meta,
        postMergeFilters: filtered.appliedFilters,
        postMergeFilterNotes: filtered.notes
      },
      dateColumns
    };
  }

  /*
    This function attaches facility lookup fields to SQL result rows. It lets the SQL stay single-table while
    the result card can still show facility names, regions, statuses, and types.
  */
  function enrichRowsWithFacilityLookup(rows, postMergeFilters) {
    const neededColumns = new Set(['facility_name']);
    postMergeFilters.forEach(filter => {
      if (filter.column) neededColumns.add(filter.column);
    });

    let enrichedCount = 0;
    const addedColumns = new Set();

    const enrichedRows = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;

      const facilityId = cleanText(row.facility_id);
      if (!facilityId) return row;

      const lookup = state.facilityLookupById.get(facilityId.toLowerCase());
      if (!lookup) return row;

      const next = { ...row };
      neededColumns.forEach(column => {
        if (next[column] == null && lookup[column] != null) {
          next[column] = lookup[column];
          addedColumns.add(column);
        }
      });

      enrichedCount += 1;
      return next;
    });

    return {
      rows: enrichedRows,
      meta: {
        lookupName: 'facility_lookup',
        primaryKey: 'facilities.facility_id',
        secondaryKey: 'transactions.facility_id',
        defaultDisplayColumn: 'facility_name',
        enrichedRows: enrichedCount,
        addedColumns: Array.from(addedColumns)
      }
    };
  }

  /*
    This function filters enriched rows after SQL execution when a requested lookup value is not present in the
    transaction table. It keeps SQL safe while still honoring lookup-based user intent.
  */
  function applyPostMergeFilters(rows, filters) {
    const notes = [];
    const appliedFilters = [];

    let nextRows = rows;

    filters.forEach(filter => {
      const column = cleanText(filter.column);
      const expected = normalizePhrase(filter.value);
      if (!column || !expected) return;

      const comparableRows = nextRows.filter(row => Object.prototype.hasOwnProperty.call(row || {}, column));
      if (!comparableRows.length) {
        notes.push(`${column} was not present after lookup enrichment; SQL transaction filters were still provided to the model.`);
        return;
      }

      const before = nextRows.length;
      nextRows = nextRows.filter(row => normalizePhrase(row[column]) === expected);
      appliedFilters.push({ column, operator: 'equals', value: filter.value, before, after: nextRows.length });
    });

    return { rows: nextRows, appliedFilters, notes };
  }

  /*
    This function finds likely date columns in result rows. It supports the result-card metadata that tells
    users whether the output is daily, weekly, monthly, or irregular.
  */
  function detectDateColumns(rows) {
    if (!rows.length) return [];

    return deriveColumns(rows).map(column => {
      const values = rows.map(row => row?.[column]).filter(value => value != null && cleanText(value) !== '').slice(0, 30);
      const granularity = inferDateGranularity(column, values);
      return granularity ? { column, granularity } : null;
    }).filter(Boolean);
  }

  /*
    This function infers a date column’s grain from its values. It distinguishes single dates, daily sequences,
    weekly spacing, monthly spacing, and irregular time series.
  */
  function inferDateGranularity(column, values) {
    const name = column.toLowerCase();
    const nameHint = /(date|day|week|month|quarter|year|timestamp|ts|time|ingested)/i.test(name);

    for (const raw of values) {
      const value = cleanText(raw);
      if (!value) continue;

      if (/^\d{4}-Q[1-4]$/i.test(value)) return 'quarter';
      if (/^\d{4}-W\d{1,2}$/i.test(value)) return 'week';
      if (/^\d{4}-\d{2}$/.test(value)) return 'month';
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return 'timestamp';
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
      if (/^\d{4}$/.test(value) && /year/i.test(name)) return 'year';

      const parsed = Date.parse(value);
      if (nameHint && Number.isFinite(parsed)) {
        return /time|timestamp|ts|ingested/i.test(name) ? 'timestamp' : 'day';
      }
    }

    return null;
  }

  /*
    Composer text normalization and chat-turn memory.
  */

  /*
    This function reads the composer text in either normal or neutral-aware mode. It preserves active reference
    tokens when needed and removes neutral tag brackets when the model should see ordinary user text.
  */
  function readComposerText(options = {}) {
    const neutralMode = options.neutralMode || 'plain';
    if (!dom.composerInput?.querySelector('.reference-token')) {
      return cleanText(dom.composerInput.innerText || dom.composerInput.textContent);
    }

    return cleanText(readComposerNodeText(dom.composerInput, neutralMode));
  }

  /*
    This function recursively reads text from composer nodes. It treats active reference tokens and neutral
    reference tokens differently so preflight scanning and model prompts use the right text.
  */
  function readComposerNodeText(node, neutralMode) {
    if (!node) return '';

    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    if (node.classList?.contains('reference-token--neutral')) {
      return neutralMode === 'blank' ? ' ' : ` ${cleanText(node.dataset.neutralPhrase || stripReferenceBrackets(node.textContent))} `;
    }

    if (node.classList?.contains('reference-token')) {
      return ` ${stripReferenceBrackets(node.textContent)} `;
    }

    if (node.tagName === 'BR') return ' ';

    return Array.from(node.childNodes).map(child => readComposerNodeText(child, neutralMode)).join('');
  }

  /*
    This function removes visible bracket syntax from neutral or rendered reference text. It keeps the final
    prompt natural for matching and model context.
  */
  function stripReferenceBrackets(value) {
    return cleanText(value).replace(/^\[|\]$/g, '');
  }

  /*
    This function clears the contenteditable prompt box and refreshes the reference count. It is used after a
    prompt is submitted or the app is reset.
  */
  function clearComposer() {
    dom.composerInput.replaceChildren();
    updateInsertedReferenceCount();
  }

  /*
    This function appends a user message to chat memory. The memory is trimmed later so Code Engine receives
    only recent context.
  */
  function addUserTurn(content) {
    state.chatTurns.push({ role: 'user', content });
    trimChatTurns();
  }

  /*
    This function appends an assistant response summary to chat memory. It helps follow-up prompts retain just
    enough prior analytical context.
  */
  function addAssistantTurn(content) {
    state.chatTurns.push({ role: 'assistant', content });
    trimChatTurns();
  }

  /*
    This function keeps the chat history within the configured turn limit. It prevents oversized prompts from
    being sent to Code Engine.
  */
  function trimChatTurns() {
    const max = Number(state.config.maxChatTurns) || 6;
    state.chatTurns = state.chatTurns.slice(-Math.max(1, max));
  }

  /*
    Code Engine package calls and response normalization.
  */

  /*
    This function retrieves and caches the transaction dataset schema through Code Engine. Caching avoids
    repeated schema calls during a session.
  */
  async function getTransactionSchema() {
    if (state.transactionSchema) return state.transactionSchema;
    if (!state.config.transactionsDatasetId) throw new Error('config.json must include transactionsDatasetId.');

    const endpoint = `/domo/codeengine/v2/packages/${encodeURIComponent(state.config.schemaPackageAlias)}`;
    const schema = await window.domo.post(endpoint, { dataset: state.config.transactionsDatasetId }, { contentType: 'application/json' });
    state.transactionSchema = schema?.firstMatch || schema?.response || schema;
    return state.transactionSchema;
  }

  /*
    This function calls the Tier 1 Code Engine package with schema-only chat context. It intentionally sends no
    references or metrics beyond the dataset schema.
  */
  async function callTier1Chat(schema) {
    const endpoint = `/domo/codeengine/v2/packages/${encodeURIComponent(state.config.tier1PackageAlias)}`;
    const payload = {
      dataset: state.config.transactionsDatasetId,
      datasetSchema: JSON.stringify(schema),
      chatTurns: JSON.stringify(state.chatTurns),
      openAIApiKey: state.config.openAIApiKey,
      model: state.config.openAIModel,
      maxRows: state.config.maxRows
    };

    console.log('[DEMO] tier1Chat request:', { ...payload, openAIApiKey: payload.openAIApiKey ? '[REDACTED]' : '' });
    return window.domo.post(endpoint, payload, { contentType: 'application/json' });
  }

  /*
    This function calls the Tier 2 Code Engine package with schema, chat turns, selected references, metrics,
    and resolved filters. Tier 3 uses the same package after reusable memory is applied.
  */
  async function callTier2Chat(schema, tierContext) {
    const endpoint = `/domo/codeengine/v2/packages/${encodeURIComponent(state.config.tier2PackageAlias)}`;
    const payload = {
      dataset: state.config.transactionsDatasetId,
      datasetSchema: JSON.stringify(schema),
      chatTurns: JSON.stringify(state.chatTurns),
      openAIApiKey: state.config.openAIApiKey,
      model: state.config.openAIModel,
      maxRows: state.config.maxRows,
      referenceContext: JSON.stringify(tierContext),
      metricsCatalog: JSON.stringify({ metrics: state.metricsCatalog.map(compactMetricForModel) })
    };

    console.log('[DEMO] tier2Chat request:', { ...payload, openAIApiKey: payload.openAIApiKey ? '[REDACTED]' : '' });
    return window.domo.post(endpoint, payload, { contentType: 'application/json' });
  }

  /*
    This function executes validated SQL through the attemptSQL Code Engine package. It returns the normalized
    row payload that the UI can render.
  */
  async function executeSqlWithAttemptSql(sql) {
    const endpoint = `/domo/codeengine/v2/packages/${encodeURIComponent(state.config.attemptSqlPackageAlias)}`;
    const payload = { dataset: state.config.transactionsDatasetId, sql };

    console.log('[DEMO] attemptSQL request:', payload);
    const response = await window.domo.post(endpoint, payload, { contentType: 'application/json' });
    console.log('[DEMO] attemptSQL response:', response);

    return normalizeAttemptSqlRows(response);
  }

  /*
    This function normalizes the SQL response returned by a chat package. It extracts SQL and preserves any
    metadata that may be useful in result cards.
  */
  function normalizeTierResponse(payload) {
    const first = payload && typeof payload === 'object' ? payload : {};
    const second = first.response && typeof first.response === 'object' ? first.response : first;
    const third = second.response && typeof second.response === 'object' ? second.response : second;

    const rows = Array.isArray(third.rows) ? third.rows : [];
    const sql = cleanText(third.sql);
    const rowCount = Number.isFinite(Number(third.rowCount)) ? Number(third.rowCount) : rows.length;

    return {
      sql,
      rows,
      rowCount,
      model: cleanText(third.model || state.config.openAIModel)
    };
  }

  /*
    This function normalizes the SQL execution package response into row objects. It handles both direct arrays
    and wrapped response shapes.
  */
  function normalizeAttemptSqlRows(payload) {
    const first = payload && typeof payload === 'object' ? payload : {};
    const candidate = first.results ?? first.response ?? first.rows ?? first.data ?? payload;
    return normalizeRowObjects(candidate);
  }

  /*
    This function converts possible result row formats into plain objects. It supports object arrays, matrix
    rows with columns, and wrapped rows.
  */
  function normalizeRowObjects(candidate) {
    if (Array.isArray(candidate)) {
      if (!candidate.length) return [];
      if (candidate.every(row => row && typeof row === 'object' && !Array.isArray(row))) return candidate;
      return candidate.map((value, index) => ({ row_number: index + 1, value }));
    }

    if (candidate && typeof candidate === 'object') {
      if (Array.isArray(candidate.rows) && Array.isArray(candidate.columns)) return convertMatrixRows(candidate.columns, candidate.rows);
      if (Array.isArray(candidate.rows)) return normalizeRowObjects(candidate.rows);
      if (Array.isArray(candidate.data)) return normalizeRowObjects(candidate.data);
    }

    return [];
  }

  /*
    This function converts column and row arrays into row objects. It is used when Domo or Code Engine returns
    tabular data as a matrix.
  */
  function convertMatrixRows(columns, rows) {
    const names = columns.map((col, index) => cleanText(col.name ?? col.column ?? col.label ?? col) || `column_${index + 1}`);
    return rows.map(row => {
      const obj = {};
      names.forEach((name, index) => {
        obj[name] = Array.isArray(row) ? row[index] : row?.[name];
      });
      return obj;
    });
  }

  /*
    Chat transcript rendering and loading-card lifecycle.
  */

  /*
    This function renders a submitted user prompt in the transcript. It delegates the actual card creation to
    the shared message renderer.
  */
  function appendUserMessage(text) {
    appendMessage('user', 'You', text);
  }

  /*
    This function renders assistant text in the transcript. It is used for initial messages, result summaries,
    and simple assistant responses.
  */
  function appendAssistantMessage(text) {
    appendMessage('assistant', 'DEMO', text);
  }

  /*
    This function creates a chat bubble for either user or assistant messages. It centralizes transcript DOM
    structure and scrolling behavior.
  */
  function appendMessage(kind, label, text) {
    const article = document.createElement('article');
    article.className = `message message--${kind}`;

    const avatar = document.createElement('div');
    avatar.className = 'message__avatar';
    avatar.textContent = kind === 'user' ? 'Y' : 'D';

    const body = document.createElement('div');
    body.className = 'message__body';

    const meta = document.createElement('p');
    meta.className = 'message__meta';
    meta.textContent = label;

    const copy = document.createElement('p');
    copy.textContent = text;

    body.append(meta, copy);
    article.append(avatar, body);
    dom.chatTranscript.appendChild(article);
    return article;
  }

  /*
    This function adds a loading card while the app resolves context, calls packages, or runs SQL. It reserves
    vertical space so the transcript does not jump while results load.
  */
  function appendLoadingCard(label) {
    const card = document.createElement('article');
    card.className = 'loading-card';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');

    const head = document.createElement('div');
    head.className = 'loading-card__head';

    const copy = document.createElement('div');

    const title = document.createElement('p');
    title.className = 'loading-card__title';
    title.textContent = 'Working On Request';

    const sub = document.createElement('p');
    sub.className = 'loading-card__sub';
    sub.textContent = label;

    const dots = document.createElement('div');
    dots.className = 'loading-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));

    copy.append(title, sub);
    head.append(copy, dots);
    card.appendChild(head);

    const buffer = document.createElement('div');
    buffer.className = 'chat-scroll-buffer';
    buffer.setAttribute('aria-hidden', 'true');
    card._scrollBuffer = buffer;

    dom.chatTranscript.append(card, buffer);
    return card;
  }

  /*
    This function updates the title on an existing loading card. It lets retry attempts and workflow phases
    communicate progress in place.
  */
  function updateLoadingCard(card, label) {
    const sub = card?.querySelector('.loading-card__sub');
    if (sub) sub.textContent = label;
  }

  /*
    This function reserves scroll-buffer height below a card. It keeps the active message readable near the top
    of the chat viewport.
  */
  function reserveScrollSpace(card, estimatedHeight) {
    const buffer = card?._scrollBuffer;
    if (!buffer) return;

    requestAnimationFrame(() => {
      const reserve = Math.max(40, Number(estimatedHeight || 260) - card.offsetHeight + 28);
      buffer.style.setProperty('--buffer-height', `${reserve}px`);
    });
  }

  /*
    This function scrolls the transcript once after a submitted turn. It avoids repeated scroll fighting while
    package calls continue.
  */
  function scrollOnceForSubmittedTurn(target, estimatedHeight) {
    requestAnimationFrame(() => {
      const container = dom.chatTranscript;
      if (!container || !target) return;

      const padding = 28;
      const plannedHeight = Math.max(target.offsetHeight || 0, Number(estimatedHeight || 240));
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      const targetBottom = target.offsetTop + plannedHeight + padding;
      container.scrollTop = Math.max(0, Math.min(maxScroll, targetBottom - container.clientHeight));
    });
  }

  /*
    This function swaps a loading card with a rendered result card. It keeps the transcript history stable while
    replacing the temporary state.
  */
  function replaceLoadingWithResult(loadingCard, result) {
    const card = createResultCard(result);
    const buffer = loadingCard?._scrollBuffer;

    if (loadingCard?.parentNode) loadingCard.replaceWith(card);
    else dom.chatTranscript.appendChild(card);

    if (buffer) buffer.style.setProperty('--buffer-height', '24px');
  }

  /*
    This function swaps a loading card with an error card. It presents failure gracefully without leaving a
    stale spinner.
  */
  function replaceLoadingWithError(loadingCard, message) {
    const card = createErrorCard(message);
    const buffer = loadingCard?._scrollBuffer;

    if (loadingCard?.parentNode) loadingCard.replaceWith(card);
    else dom.chatTranscript.appendChild(card);

    if (buffer) buffer.style.setProperty('--buffer-height', '24px');
  }

  /*
    Result card, metadata, row table, and feedback controls.
  */

  /*
    This function builds the main result card after SQL execution. It shows row counts, metadata chips, SQL
    text, enrichment notes, result-table access, and feedback controls.
  */
  function createResultCard(result) {
    const card = document.createElement('article');
    card.className = 'result-card';

    const head = document.createElement('div');
    head.className = 'result-card__head';

    const copy = document.createElement('div');

    const title = document.createElement('p');
    title.className = 'result-card__title';
    title.textContent = 'Results Found';

    const sub = document.createElement('p');
    sub.className = 'result-card__sub';
    sub.textContent = result.fromPlaybook ? 'Saved Playbook Reused' : result.fromTemplate ? 'Saved Template Reused' : 'Query Complete';

    copy.append(title, sub);

    const savePlaybookButton = document.createElement('button');
    savePlaybookButton.type = 'button';
    savePlaybookButton.className = 'save-playbook-button';
    savePlaybookButton.textContent = 'Save Playbook';
    savePlaybookButton.addEventListener('click', () => savePlaybookFromResult(result, savePlaybookButton));

    head.append(copy, savePlaybookButton);

    const summary = document.createElement('div');
    summary.className = 'result-summary';
    summary.append(
      createRowsButton(result),
      createResultChip(result.model || 'Model'),
      createResultChip('SQL Available')
    );

    if (result.fromTemplate) summary.appendChild(createResultChip('Template Reused'));
    buildResultMetadataChips(result).forEach(chip => summary.appendChild(chip));

    const hint = document.createElement('p');
    hint.className = 'result-card__copy';
    hint.textContent = `${String(result.tier || 'tier1').replace('tier', 'Tier ')} architecture used.`;

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    const sqlButton = document.createElement('button');
    sqlButton.type = 'button';
    sqlButton.className = 'ghost-button';
    sqlButton.textContent = 'Show SQL';

    const sqlPanel = document.createElement('div');
    sqlPanel.className = 'sql-panel';
    sqlPanel.hidden = true;

    const pre = document.createElement('pre');
    pre.textContent = result.sql || 'No SQL returned.';
    sqlPanel.appendChild(pre);

    sqlButton.addEventListener('click', () => {
      sqlPanel.hidden = !sqlPanel.hidden;
      sqlButton.textContent = sqlPanel.hidden ? 'Show SQL' : 'Hide SQL';
    });

    actions.appendChild(sqlButton);

    const mergePanel = createDataMergePanel(result);
    if (mergePanel) {
      const mergeButton = document.createElement('button');
      mergeButton.type = 'button';
      mergeButton.className = 'ghost-button';
      mergeButton.textContent = 'Show Data Merge';

      mergeButton.addEventListener('click', () => {
        mergePanel.hidden = !mergePanel.hidden;
        mergeButton.textContent = mergePanel.hidden ? 'Show Data Merge' : 'Hide Data Merge';
      });

      actions.appendChild(mergeButton);
    }

    const isPlaybookGenerated = Boolean(result.fromPlaybook || result.playbook || result.model === 'saved-playbook');

    card.append(head, summary, hint, actions, sqlPanel);
    if (mergePanel) card.appendChild(mergePanel);
    if (!isPlaybookGenerated) card.appendChild(createFeedbackControls(result));

    return card;
  }


  /*
    This function builds the optional data-merge explanation panel for enriched or post-filtered results. It
    documents how lookup data affected the displayed rows.
  */
  function createDataMergePanel(result) {
    const enrichment = result.enrichment || {};
    const hasMerge = Array.isArray(enrichment.addedColumns) && enrichment.addedColumns.length;
    const hasFilters = Array.isArray(enrichment.postMergeFilters) && enrichment.postMergeFilters.length;
    const hasNotes = Array.isArray(enrichment.postMergeFilterNotes) && enrichment.postMergeFilterNotes.length;

    if (!hasMerge && !hasFilters && !hasNotes) return null;

    const panel = document.createElement('div');
    panel.className = 'merge-panel';
    panel.hidden = true;

    const rows = [
      ['Lookup resource', enrichment.lookupName || 'facility_lookup'],
      ['Primary key', enrichment.primaryKey || 'facilities.facility_id'],
      ['Secondary key', enrichment.secondaryKey || 'transactions.facility_id'],
      ['Default joined field', enrichment.defaultDisplayColumn || 'facility_name'],
      ['Added fields', hasMerge ? enrichment.addedColumns.join(', ') : 'None'],
      ['Matched rows', Number.isFinite(Number(enrichment.enrichedRows)) ? Number(enrichment.enrichedRows).toLocaleString() : '0']
    ];

    if (hasFilters) {
      rows.push([
        'Post-merge filters',
        enrichment.postMergeFilters.map(filter => `${filter.column} ${filter.operator || '='} ${filter.value} (${filter.before} → ${filter.after})`).join('; ')
      ]);
    }

    if (hasNotes) rows.push(['Notes', enrichment.postMergeFilterNotes.join(' ')]);

    rows.forEach(([labelText, valueText]) => {
      const row = document.createElement('div');
      row.className = 'merge-panel__row';

      const label = document.createElement('span');
      label.className = 'merge-panel__label';
      label.textContent = labelText;

      const value = document.createElement('span');
      value.className = 'merge-panel__value';
      value.textContent = valueText;

      row.append(label, value);
      panel.appendChild(row);
    });

    return panel;
  }

  /*
    This function builds compact metadata chips for a result card. It summarizes row counts, model behavior,
    reusable pattern use, date grain, and context state.
  */
  function buildResultMetadataChips(result) {
    const chips = [];
    const enrichment = result.enrichment || {};

    if (Array.isArray(enrichment.addedColumns) && enrichment.addedColumns.length) {
      chips.push(createResultChip(`Lookup: ${enrichment.addedColumns.join(', ')}`, 'result-chip--soft'));
    }

    if (Array.isArray(enrichment.postMergeFilters) && enrichment.postMergeFilters.length) {
      enrichment.postMergeFilters.forEach(filter => {
        chips.push(createResultChip(`Filter: ${filter.column}=${filter.value}`, 'result-chip--soft'));
      });
    }

    if (Array.isArray(result.dateColumns) && result.dateColumns.length) {
      result.dateColumns.slice(0, 2).forEach(date => {
        chips.push(createResultChip(`Date Grain: ${date.column} ${date.granularity}`, 'result-chip--soft'));
      });
    }

    if (result.rawRowCount != null && result.rawRowCount !== result.rowCount) {
      chips.push(createResultChip(`Post Filtered: ${result.rawRowCount} → ${result.rowCount}`, 'result-chip--soft'));
    }

    return chips;
  }

  /*
    This function creates the button that opens the full-results modal. It displays the row count and keeps
    large tables out of the compact result card.
  */
  function createRowsButton(result) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-chip result-chip--button';
    button.textContent = `${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? 'Row' : 'Rows'}`;
    button.addEventListener('click', () => openResultsModal(result));
    return button;
  }

  /*
    This function creates one metadata chip for a result card. It supports both static chips and button-styled
    chips.
  */
  function createResultChip(text, extraClass = '') {
    const chip = document.createElement('span');
    chip.className = `result-chip ${extraClass}`.trim();
    chip.textContent = text;
    return chip;
  }

  /*
    This function appends an error card directly to the transcript. It is used when a failure happens before a
    loading card exists.
  */
  function appendErrorCard(text) {
    const card = createErrorCard(text);
    dom.chatTranscript.appendChild(card);
    scrollOnceForSubmittedTurn(card, 160);
  }

  /*
    This function creates an accessible error card. It uses concise operator-facing copy and avoids exposing raw
    stack traces.
  */
  function createErrorCard(text) {
    const card = document.createElement('article');
    card.className = 'error-card';

    const head = document.createElement('div');
    head.className = 'error-card__head';

    const copy = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'error-card__title';
    title.textContent = 'Request Stopped';

    const sub = document.createElement('p');
    sub.className = 'error-card__sub';
    sub.textContent = text;

    copy.append(title, sub);
    head.appendChild(copy);
    card.appendChild(head);
    return card;
  }

  /*
    This function builds the thumbs-up and thumbs-down controls for a result. Positive feedback can save a
    learned template, while negative feedback is recorded as an ignored result.
  */
  function createFeedbackControls(result) {
    const wrap = document.createElement('div');
    wrap.className = 'feedback-row';

    const label = document.createElement('span');
    label.className = 'feedback-row__label';
    label.textContent = 'Feedback:';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'feedback-button feedback-button--up';
    up.setAttribute('aria-label', 'Thumbs up');
    up.appendChild(createFeedbackIcon('up'));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'feedback-button feedback-button--down';
    down.setAttribute('aria-label', 'Thumbs down');
    down.appendChild(createFeedbackIcon('down'));

    const status = document.createElement('span');
    status.className = 'feedback-row__status';

    up.addEventListener('click', () => handleFeedback(result, 'up', up, down, status));
    down.addEventListener('click', () => handleFeedback(result, 'down', up, down, status));

    wrap.append(label, up, down, status);
    return wrap;
  }

  /*
    This function creates the SVG icon used by a feedback button. It keeps the icon markup consistent for up and
    down feedback.
  */
  function createFeedbackIcon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('feedback-button__icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-width', '1.9');

    if (kind === 'up') {
      path.setAttribute('d', 'M7 11v9M7 11l4.6-7.2c.5-.8 1.8-.5 1.8.5v4.2h5.1c1 0 1.7.9 1.5 1.9l-1.4 7.1c-.2.9-1 1.5-1.9 1.5H7m0-8H4.5c-.8 0-1.5.7-1.5 1.5v5c0 .8.7 1.5 1.5 1.5H7');
    } else {
      path.setAttribute('d', 'M7 13V4M7 13l4.6 7.2c.5.8 1.8.5 1.8-.5v-4.2h5.1c1 0 1.7-.9 1.5-1.9l-1.4-7.1c-.2-.9-1-1.5-1.9-1.5H7m0 8H4.5C3.7 13 3 12.3 3 11.5v-5C3 5.7 3.7 5 4.5 5H7');
    }

    svg.appendChild(path);
    return svg;
  }

  /*
    This function handles user feedback on a result card. It updates button state, saves a reusable template on
    positive feedback, and reports status without resubmitting the prompt.
  */
  async function handleFeedback(result, value, upButton, downButton, status) {
    result.feedback = value;

    upButton.classList.toggle('is-selected', value === 'up');
    downButton.classList.toggle('is-selected', value === 'down');

    if (value !== 'up') {
      status.textContent = 'Marked for review.';
      return;
    }

    if (result.tier !== 'tier3' || result.fromTemplate) {
      status.textContent = result.fromTemplate ? 'Template already reused.' : 'Saved templates are Tier 3 only.';
      return;
    }

    try {
      status.textContent = 'Saving learned template...';
      await saveTemplateFromResult(result);
      status.textContent = 'Learned template saved.';
    } catch (error) {
      console.error('[DEMO] Template save failed:', error);
      status.textContent = 'Template save failed.';
    }
  }

  /*
    Template learning, SQL template safety, and reusable slot rendering.
  */

  /*
    This function saves a learned template from a successful result when it is safe to reuse. It writes the
    template into AppDB and refreshes the local Tier 3 cache.
  */
  async function saveTemplateFromResult(result) {
    const template = buildTemplateFromResult(result);
    validateSqlTemplateSafety(template.sqlTemplate);

    const saved = await createAppDbContentDocument(state.config.templatesCollection, template);
    const storedTemplate = { ...template, __appDbId: saved.appDbId };
    state.templates = dedupeBySignature([storedTemplate, ...state.templates], item => item.id);
  }

  /*
    This function validates a stored SQL template before it can be reused. It rejects unsafe SQL features and
    only allows known placeholder tokens.
  */
  function validateSqlTemplateSafety(sqlTemplate) {
    const sql = cleanText(sqlTemplate);

    if (!/^select\b/i.test(sql)) throw new Error('Template SQL must start with SELECT.');
    if (/[;]/.test(sql)) throw new Error('Template SQL must not contain semicolons.');
    if (/--|\/\*|\*\//.test(sql)) throw new Error('Template SQL must not contain comments.');
    if (!/\bfrom\s+table\s+(?:as\s+)?o\b/i.test(sql)) throw new Error('Template SQL must use FROM table o.');
    if (/\bo\.(facility_name|facility_status|facility_type|region_name)\b/i.test(sql)) {
      throw new Error('Template SQL must use facility_id for lookup-derived facility fields.');
    }

    const banned = /\b(join|with|union|intersect|except|insert|update|delete|merge|create|drop|alter|grant|revoke|truncate|call|exec|execute)\b/i;
    if (banned.test(sql)) throw new Error('Template SQL contains a disallowed keyword.');

    if (/\bfrom\s*\(|\(\s*select\b/i.test(sql)) {
      throw new Error('Template SQL must not contain subqueries or derived tables.');
    }
  }

/*
  This function returns the transaction columns that templates may use as dynamic breakdown dimensions.
  Limiting this list prevents arbitrary SQL identifiers from being injected.
*/
function allowedTemplateDimensionColumns() {
    return [
      'facility_id',
      'robot_id',
      'robot_class',
      'shift_name',
      'task_type',
      'task_status',
      'assigned_priority',
      'source_system',
      'failure_reason_code',
      'task_failed_flag',
      'sla_breached_flag',
      'maintenance_ticket_flag',
      'near_miss_flag',
      'quality_issue_flag'
    ];
  }

/*
  This function converts a successful result SQL statement into a slot-based reusable template. It replaces
  metric, date, dimension, and where-clause portions with controlled placeholders.
*/
function buildSlotSqlTemplateFromResult(result, signature, dateWindow) {
    const hasMetric = normalizeList(result.tierContext?.selectedMetrics).length > 0 || signature.metricKeys.length > 0;
    const asksCount = signature.stat === 'count';
    const hasReusableShape = hasMetric || asksCount;

    if (!hasReusableShape) return '';

    const metricPart = hasMetric ? '{{metric_selects}}' : 'COUNT(*) AS event_count';
    const hasDimension = signature.breakdownColumns.length > 0;
    const selectParts = hasDimension ? ['{{dimension_selects}}', metricPart] : [metricPart];
    const groupPart = hasDimension ? ' GROUP BY {{dimension_group_by}}' : '';

    return `SELECT ${selectParts.join(', ')} FROM table o {{where_clause}}${groupPart} LIMIT {{max_rows}}`;
  }

/*
  This function renders the SELECT expressions for metrics requested by the current prompt. It allows a saved
  template to swap Bot Burden for Charge Choke or another supported metric safely.
*/
function renderMetricSelectsForTemplate(template, prompt, tierContext) {
    const metrics = getMetricsForTemplate(template, prompt, tierContext);

    if (!metrics.length) {
      const stat = cleanText(template.intentSignature?.stat);
      if (stat === 'count') return 'COUNT(*) AS event_count';
      throw new Error('Template requires a metric slot.');
    }

    return metrics.map(metric => {
      const calculation = cleanText(metric.calculation);
      const alias = cleanText(metric.defaultAlias || `${safeId(metric.name || metric.key)}_value`);
      if (!calculation || !alias) throw new Error('Template metric is missing a calculation or alias.');
      return `${calculation} AS ${alias}`;
    }).join(', ');
  }

/*
  This function selects the current metrics that should fill a template. It prefers current prompt context and
  falls back to the saved template signature only when needed.
*/
function getMetricsForTemplate(template, prompt, tierContext) {
    const selected = normalizeList(tierContext.selectedMetrics);
    if (selected.length) return selected;

    const fromPrompt = detectImplicitMetrics(prompt);
    if (fromPrompt.length) return fromPrompt.map(compactMetricForModel);

    const defaultMetrics = normalizeList(template.defaultMetrics);
    if (defaultMetrics.length) return defaultMetrics;

    const defaultKeys = normalizeList(template.intentSignature?.defaultMetricKeys);
    return defaultKeys
      .map(key => state.metricsCatalog.find(metric => metric.key === key))
      .filter(Boolean)
      .map(compactMetricForModel);
  }

/*
  This function selects the primary breakdown dimension for a template. It exists for older single-dimension
  templates and delegates modern logic to getDimensionsForTemplate.
*/
function getDimensionForTemplate(template, prompt, tierContext) {
    return getDimensionsForTemplate(template, prompt, tierContext)[0] || '';
  }

  /*
    This function determines which breakdown dimensions should fill a template. It prefers dimensions requested
    in the current prompt and falls back to saved template dimensions only when compatible.
  */
  function getDimensionsForTemplate(template, prompt, tierContext) {
    const defaultColumns = [
      ...normalizeList(template.intentSignature?.defaultDimensionColumns),
      cleanText(template.intentSignature?.defaultDimensionColumn)
    ].filter(Boolean);

    const promptColumns = extractBreakdownColumns(prompt);
    const contextColumns = normalizeList(tierContext.breakdownColumns).map(cleanText).filter(Boolean);

    const requestedColumns = dedupeBySignature([
      ...contextColumns,
      ...promptColumns
    ], column => column);

    const candidates = requestedColumns.length ? requestedColumns : defaultColumns;

    const allowed = new Set(allowedTemplateDimensionColumns());
    const found = dedupeBySignature(candidates, column => column).filter(column => allowed.has(column));
    if (!found.length && template.intentSignature?.dimensionSlot) throw new Error('Template requires a supported breakdown dimension.');
    return found;
  }

  /*
    This function renders SELECT expressions for requested template dimensions. It quotes aliases safely while
    using only allowed transaction columns.
  */
  function renderDimensionSelectsForTemplate(template, prompt, tierContext) {
    return getDimensionsForTemplate(template, prompt, tierContext).map(column => `o.${column}`).join(', ');
  }

  /*
    This function renders the GROUP BY clause for requested template dimensions. It omits GROUP BY when the
    current prompt is aggregate-only.
  */
  function renderDimensionGroupByForTemplate(template, prompt, tierContext) {
    return getDimensionsForTemplate(template, prompt, tierContext).map(column => `o.${column}`).join(', ');
  }

/*
  This function renders the WHERE clause for a reusable template. It combines a safe date window with resolved
  transaction filters and omits empty clauses.
*/
function renderWhereClauseForTemplate(template, prompt, tierContext, metrics) {
    const clauses = [];
    const requiresDate = Boolean(template.intentSignature?.dateWindowRequired) || /\{\{date_filter\}\}/.test(template.sqlTemplate || '');
    const dateWindow = parseDateWindow(prompt) || tierContext.learnedDateWindow;

    if (requiresDate) {
      if (!dateWindow) throw new Error('Template requires a date window.');
      clauses.push(dateWindowToSql(dateWindow, getDateColumnForMetrics(metrics)));
    }

    const filters = dedupeFilters(normalizeList(tierContext.transactionFilters));
    const requiredFilterColumns = normalizeList(template.intentSignature?.requiredTransactionFilterColumns).map(cleanText).filter(Boolean);

    requiredFilterColumns.forEach(column => {
      if (!filters.some(filter => filter.column === column && normalizeList(filter.values).length)) {
        throw new Error(`Template requires a ${column} filter.`);
      }
    });

    const filterSql = filters.map(transactionFilterToSql).filter(Boolean);
    clauses.push(...filterSql);

    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }

/*
  This function converts one resolved transaction filter into SQL. It uses equality for one value and IN lists
  for multiple values.
*/
function transactionFilterToSql(filter) {
    const column = cleanText(filter.column);
    const values = normalizeList(filter.values).map(cleanText).filter(Boolean);

    if (!column || !values.length) return '';
    if (values.length === 1) return `o.${column} = '${escapeSqlLiteral(values[0])}'`;
    return `o.${column} IN (${formatSqlList(values)})`;
  }




  /*
    Learning context extraction from successful results.
  */

  /*
    This function extracts the learning context that should be saved with a successful result. It captures
    relevant prompt history, reusable signals, metrics, breakdowns, filters, and date windows.
  */
  function buildLearningContextFromResult(result) {
    const sourcePrompts = selectRelevantLearningPrompts(result);
    const resolvedPrompt = sourcePrompts.join(' ; ');
    const inferredMetrics = inferMetricsFromSql(result.sql);
    const inferredBreakdowns = inferBreakdownColumnsFromSql(result.sql);
    const inferredDateWindow = parseDateWindow(resolvedPrompt) || inferDateWindowFromSql(result.sql);
    const tierContext = cloneJson(result.tierContext || emptyTierContext());

    tierContext.selectedMetrics = dedupeBySignature([
      ...normalizeList(tierContext.selectedMetrics),
      ...inferredMetrics.map(compactMetricForModel)
    ], metric => metric.key || metric.name);

    tierContext.breakdownColumns = dedupeBySignature([
      ...normalizeList(tierContext.breakdownColumns).map(cleanText),
      ...inferredBreakdowns
    ].filter(Boolean), column => column);

    if (inferredDateWindow) tierContext.learnedDateWindow = inferredDateWindow;

    return {
      latestPrompt: cleanText(result.prompt),
      sourcePrompts,
      resolvedPrompt,
      tierContext,
      inferredMetrics,
      inferredBreakdowns,
      dateWindow: inferredDateWindow,
      isFollowUp: isFollowUpPrompt(result.prompt)
    };
  }

  /*
    This function selects chat prompts that are useful for template learning. It keeps the latest prompt and
    includes prior prompts only when they appear necessary for context.
  */
  function selectRelevantLearningPrompts(result) {
    const current = cleanText(result.prompt);
    const userTurns = state.chatTurns
      .filter(turn => turn.role === 'user')
      .map(turn => cleanText(turn.content))
      .filter(Boolean);

    if (!userTurns.length) return [current].filter(Boolean);

    const latestIndex = Math.max(0, userTurns.length - 1);
    const selected = current ? [current] : [userTurns[latestIndex]];
    const shouldLookBack = isFollowUpPrompt(current) || promptNeedsPriorContext(current);

    if (!shouldLookBack) return dedupeBySignature(selected, phrase => normalizePhrase(phrase));

    for (let i = latestIndex - 1; i >= 0 && selected.length < 4; i -= 1) {
      const candidate = userTurns[i];
      if (!candidate) continue;

      if (promptHasReusableSignal(candidate, result) || selected.length === 1) {
        selected.unshift(candidate);
      }

      if (!isFollowUpPrompt(candidate)) break;
    }

    return dedupeBySignature(selected, phrase => normalizePhrase(phrase)).slice(-4);
  }

  /*
    This function detects short follow-up prompts. It helps decide when previous chat turns should be included
    in a learned template’s trigger phrases.
  */
  function isFollowUpPrompt(prompt) {
    return /\b(also|include|add|remove|exclude|only|just|same|again|instead|break\s+that\s+down|split\s+that|filter\s+that|compare\s+that|show\s+that|with|without|those|that|it)\b/i.test(cleanText(prompt));
  }

  /*
    This function determines whether a prompt depends on previous chat context. It looks for pronouns and
    comparative language that cannot stand alone reliably.
  */
  function promptNeedsPriorContext(prompt) {
    const text = normalizePhrase(prompt);
    const hasMetric = detectImplicitMetrics(text).length > 0;
    const hasReference = detectImplicitReferences(text, []).length > 0;
    const hasDate = Boolean(parseDateWindow(text));
    const hasBreakdown = extractBreakdownColumns(text).length > 0;
    return !(hasMetric || hasReference || hasDate || hasBreakdown);
  }

  /*
    This function checks whether a prompt contains enough analytical structure to learn from it. It avoids
    saving templates for vague or one-off requests.
  */
  function promptHasReusableSignal(prompt, result) {
    return detectImplicitMetrics(prompt).length > 0
      || detectImplicitReferences(prompt, []).length > 0
      || extractBreakdownColumns(prompt).length > 0
      || Boolean(parseDateWindow(prompt))
      || inferMetricsFromSql(result.sql).some(metric => triggerMatchesPrompt({ phrases: metricTriggerPhrases(metric, prompt) }, prompt));
  }

  /*
    This function infers metric keys from SQL text. It lets the app recover metric identity when the stored
    runtime context is incomplete.
  */
  function inferMetricsFromSql(sql) {
    const text = normalizeSqlForMatch(sql);
    return state.metricsCatalog.filter(metric => {
      const alias = normalizeSqlForMatch(metric.defaultAlias);
      const calculation = normalizeSqlForMatch(metric.calculation);
      const key = normalizeSqlForMatch(metric.key);
      const name = normalizeSqlForMatch(metric.name);

      return (alias && text.includes(alias))
        || (calculation && text.includes(calculation))
        || (key && text.includes(key))
        || (name && text.includes(name));
    });
  }

  /*
    This function normalizes SQL text for template comparison. It collapses whitespace and lowercases so similar
    SQL can be matched consistently.
  */
  function normalizeSqlForMatch(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/`/g, '');
  }

  /*
    This function infers GROUP BY breakdown columns from SQL. It supports template signatures when the current
    runtime context did not explicitly record a dimension.
  */
  function inferBreakdownColumnsFromSql(sql) {
    const allowed = new Set(allowedTemplateDimensionColumns());
    const groupMatch = cleanText(sql).match(/\bgroup\s+by\s+(.+?)(?:\border\s+by\b|\blimit\b|$)/i);
    if (!groupMatch) return [];

    const columns = [];
    const refs = groupMatch[1].match(/\bo\.([A-Za-z_][A-Za-z0-9_]*)\b/g) || [];
    refs.forEach(ref => {
      const column = ref.slice(2);
      if (allowed.has(column)) columns.push(column);
    });

    return dedupeBySignature(columns, column => column);
  }

  /*
    This function infers a relative or absolute date window from SQL text. It helps saved templates retain a
    reusable time-window slot.
  */
  function inferDateWindowFromSql(sql) {
    const text = cleanText(sql);

    const lastDays = text.match(/DATE_SUB\s*\(\s*CURRENT_DATE\(\)\s*,\s*INTERVAL\s+(\d+)\s+DAY\s*\)/i);
    if (lastDays && /<\s*CURRENT_DATE\(\)/i.test(text)) {
      const n = Number(lastDays[1]) || 7;
      return {
        kind: 'last_n_days',
        n,
        label: `last ${n} days`,
        dateColumn: inferDateColumnFromSql(text),
        dynamic: true
      };
    }

    const lastMonths = text.match(/DATE_SUB\s*\(\s*CURRENT_DATE\(\)\s*,\s*INTERVAL\s+(\d+)\s+MONTH\s*\)/i);
    if (lastMonths && /<\s*CURRENT_DATE\(\)/i.test(text)) {
      const n = Number(lastMonths[1]) || 1;
      return {
        kind: 'last_n_months',
        n,
        label: `last ${n} months`,
        dateColumn: inferDateColumnFromSql(text),
        dynamic: true
      };
    }

    if (/DATE_SUB\s*\(\s*DATE_SUB\s*\(\s*CURRENT_DATE\(\)\s*,\s*INTERVAL\s+WEEKDAY\s*\(\s*CURRENT_DATE\(\)\s*\)\s+DAY\s*\)\s*,\s*INTERVAL\s+7\s+DAY\s*\)/i.test(text)) {
      return {
        kind: 'last_complete_week',
        label: 'last complete week',
        dateColumn: inferDateColumnFromSql(text),
        dynamic: true
      };
    }

    const literalRange = text.match(/DATE\s*\(\s*o\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*>=\s*DATE\s*\(\s*'(\d{4}-\d{2}-\d{2})'\s*\)\s+AND\s+DATE\s*\(\s*o\.\1\s*\)\s*<\s*DATE\s*\(\s*'(\d{4}-\d{2}-\d{2})'\s*\)/i);
    if (literalRange) {
      return {
        kind: 'between_dates',
        start: literalRange[2],
        end: literalRange[3],
        label: `${literalRange[2]} to ${literalRange[3]}`,
        dateColumn: literalRange[1],
        dynamic: false
      };
    }

    return null;
  }

  /*
    This function infers which event date column a SQL statement uses. It defaults to event_date when no more
    specific date column is found.
  */
  function inferDateColumnFromSql(sql) {
    const match = cleanText(sql).match(/DATE\s*\(\s*o\.([A-Za-z_][A-Za-z0-9_]*)\s*\)/i);
    return match ? match[1] : 'event_date';
  }

/*
  Template construction, trigger-map generation, and intent signatures.
*/

/*
  This function builds the AppDB template document from a successful result. It stores SQL slots, intent
  signature, trigger map, prompt phrases, and safety metadata.
*/
function buildTemplateFromResult(result) {
    const learning = buildLearningContextFromResult(result);
    const signature = buildIntentSignature(learning.resolvedPrompt, learning.tierContext);
    const dateWindow = learning.dateWindow || parseDateWindow(learning.resolvedPrompt);
    const title = buildTemplateTitle(signature, learning.resolvedPrompt);
    const now = new Date().toISOString();
    const sqlTemplate = buildSlotSqlTemplateFromResult(result, signature, dateWindow)
      || generalizeSqlTemplate(result.sql, learning.tierContext, dateWindow);
    const triggerMap = buildTriggerMapFromResult(result, signature, dateWindow, learning);
    const selectedMetrics = normalizeList(learning.tierContext?.selectedMetrics).map(metric => compactMetricForModel(metric));
    const transactionFilters = normalizeList(learning.tierContext?.transactionFilters);

    return {
      id: `tpl_${safeId(title)}_${Date.now()}`,
      type: 'template',
      title,
      description: `Reusable ${title.toLowerCase()} pattern with variable metrics, references, dimensions, and dates when those slots are present.`,
      sourcePrompt: learning.resolvedPrompt,
      latestPrompt: cleanText(result.prompt),
      sourcePrompts: learning.sourcePrompts,
      normalizedPrompt: normalizePhrase(learning.resolvedPrompt),
      matchPhrases: buildTemplateMatchPhrases(result, triggerMap, learning),
      intentSignature: {
        ...signature,
        requiredTransactionFilterColumns: dedupeBySignature(transactionFilters.map(filter => cleanText(filter.column)).filter(Boolean), column => column),
        allowedDimensionColumns: allowedTemplateDimensionColumns(),
        defaultMetricKeys: selectedMetrics.map(metric => metric.key).filter(Boolean),
        defaultDimensionColumn: signature.breakdownColumns[0] || '',
        defaultDimensionColumns: signature.breakdownColumns,
        dateWindowKind: dateWindow?.kind || ''
      },
      slots: buildTemplateSlots(signature, learning.tierContext),
      triggerMap,
      sqlTemplate,
      defaultMetrics: selectedMetrics,
      defaultDateWindowKind: dateWindow?.kind || '',
      outputColumns: deriveColumns(result.rows).map(name => ({
        name,
        role: name === 'facility_id' ? 'lookup_key' : 'result',
        label: name
      })),
      mergePlan: {
        lookupAlias: 'facilities',
        transactionKey: 'facility_id',
        lookupKey: 'facility_id',
        defaultJoinColumns: ['facility_name']
      },
      usageCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }


  /*
    This function builds a readable title for a learned template. It combines the inferred stat, pattern,
    metrics, and prompt wording into a compact label.
  */
  function buildTemplateTitle(signature, prompt) {
    const metricPart = signature.metricKeys.length
      ? signature.metricKeys.map(key => {
        const metric = state.metricsCatalog.find(item => item.key === key);
        return metric?.name || key;
      }).join(' + ')
      : cleanText(prompt).split(/\s+/).slice(0, 5).join(' ');

    const filterPart = signature.filterDimensions.length
      ? ` by ${signature.filterDimensions.join(', ')}`
      : '';

    const breakdownPart = signature.breakdownColumns.length
      ? ` broken out by ${signature.breakdownColumns.join(', ')}`
      : '';

    return `${metricPart}${filterPart}${breakdownPart}`.slice(0, 120);
  }
/*
  This function describes the dynamic slots that a template can safely fill later. It records metric, date-
  window, dimension, and filter slot expectations.
*/
function buildTemplateSlots(signature, tierContext = {}) {
    const slots = [];

    if (signature.metricSlot) {
      slots.push({
        name: 'metric',
        kind: 'metric',
        required: true,
        defaultMetricKeys: signature.metricKeys
      });
    }

    if (signature.dimensionSlot) {
      slots.push({
        name: 'dimension',
        kind: 'dimension',
        required: true,
        allowedColumns: allowedTemplateDimensionColumns(),
        defaultColumn: signature.breakdownColumns[0] || '',
        defaultColumns: signature.breakdownColumns
      });
    }

    if (signature.dateWindowRequired) {
      slots.push({
        name: 'date_window',
        kind: 'date_window',
        required: true,
        dateColumn: getDateColumnForMetrics(tierContext.selectedMetrics)
      });
    }

    signature.filterDimensions.forEach(column => {
      slots.push({
        name: column,
        kind: ['facility_name', 'facility_status', 'facility_type', 'region_name'].includes(column) ? 'lookup_filter' : 'transaction_filter',
        required: true,
        lookupAlias: 'facilities',
        lookupColumn: column,
        transactionKey: 'facility_id',
        lookupKey: 'facility_id'
      });
    });

    return slots;
  }
/*
  This function builds the phrases that can reactivate a saved template. It stores metric, dimension, lookup,
  transaction, and date-window triggers derived from the successful prompt.
*/
function buildTriggerMapFromResult(result, signature, dateWindow, learning = null) {
    const prompt = cleanText(learning?.resolvedPrompt || result.prompt);
    const sourcePrompts = normalizeList(learning?.sourcePrompts).length ? learning.sourcePrompts : [prompt];
    const selectedMetrics = learning?.tierContext?.selectedMetrics || result.tierContext?.selectedMetrics || [];
    const selectedReferences = learning?.tierContext?.selectedReferences || result.tierContext?.selectedReferences || [];
    const exactPrompts = learning?.isFollowUp
      ? [prompt]
      : [prompt, cleanText(result.prompt)];

    return {
      exactPrompts: dedupeBySignature(exactPrompts.filter(Boolean), phrase => normalizePhrase(phrase)),
      metrics: selectedMetrics.map(metric => ({
        phrases: metricTriggerPhrases(metric, prompt),
        slot: 'metric',
        metricKey: metric.key
      })).filter(trigger => trigger.metricKey && trigger.phrases.length),
      dimensions: signature.breakdownColumns.map(column => ({
        phrases: dimensionTriggerPhrases(column).filter(phrase => sourcePrompts.some(src => normalizePhrase(src).includes(normalizePhrase(phrase))) || !learning?.isFollowUp),
        slot: 'breakdown',
        column,
        requiresLookupMerge: column === 'facility_id',
        defaultDisplayColumn: column === 'facility_id' ? 'facility_name' : ''
      })).map(trigger => ({
        ...trigger,
        phrases: trigger.phrases.length ? trigger.phrases : dimensionTriggerPhrases(trigger.column)
      })).filter(trigger => trigger.column && trigger.phrases.length),
      lookupFilters: selectedReferences
        .filter(ref => ref.lookupColumn && ref.lookupValue)
        .map(ref => ({
          phrases: lookupTriggerPhrases(ref),
          slot: ref.lookupColumn,
          lookupAlias: 'facilities',
          lookupColumn: ref.lookupColumn,
          lookupValue: ref.lookupValue,
          transactionColumn: ref.transactionKey || 'facility_id',
          matchingKeys: ref.matchingKeys || []
        }))
        .filter(trigger => trigger.phrases.length),
      transactionFilters: selectedReferences
        .filter(ref => ref.sqlColumn && ref.sqlValue)
        .map(ref => ({
          phrases: transactionTriggerPhrases(ref),
          slot: ref.sqlColumn,
          column: ref.sqlColumn,
          value: ref.sqlValue,
          source: ref.sourceTable || 'transactions',
          category: ref.category || ''
        }))
        .filter(trigger => trigger.phrases.length),
      referenceCategories: selectedReferences.map(ref => ({
        category: ref.category || '',
        sqlColumn: ref.sqlColumn || '',
        lookupColumn: ref.lookupColumn || '',
        transactionKey: ref.transactionKey || '',
        sourceTable: ref.sourceTable || ''
      })).filter(ref => ref.category),
      dateWindows: dateWindow ? [{
        phrases: dateWindowTriggerPhrases(dateWindow, prompt),
        slot: 'date_window',
        dateColumn: dateWindow.dateColumn || 'event_date',
        kind: dateWindow.kind,
        reusable: true
      }] : []
    };
  }



  /*
    This function creates natural-language phrases used for later template matching. It combines the current
    prompt, relevant history, and learned trigger phrases.
  */
  function buildTemplateMatchPhrases(result, triggerMap, learning = null) {
    const phrases = [cleanText(learning?.resolvedPrompt || result.prompt)];

    if (!learning?.isFollowUp) phrases.push(cleanText(result.prompt));

    normalizeList(triggerMap.exactPrompts).forEach(phrase => phrases.push(phrase));
    normalizeList(triggerMap.metrics).forEach(trigger => phrases.push(...normalizeList(trigger.phrases)));
    normalizeList(triggerMap.dimensions).forEach(trigger => phrases.push(...normalizeList(trigger.phrases)));
    normalizeList(triggerMap.lookupFilters).forEach(trigger => phrases.push(...normalizeList(trigger.phrases)));
    normalizeList(triggerMap.transactionFilters).forEach(trigger => phrases.push(...normalizeList(trigger.phrases)));
    normalizeList(triggerMap.dateWindows).forEach(trigger => phrases.push(...normalizeList(trigger.phrases)));

    return dedupeBySignature(phrases.map(cleanText).filter(Boolean), phrase => normalizePhrase(phrase)).slice(0, 80);
  }


  /*
    This function creates trigger phrases for a metric. It includes names and aliases so future prompts can
    reuse the same template with different metrics.
  */
  function metricTriggerPhrases(metric, prompt) {
    const candidates = [metric.name, metric.key, ...(metric.aliases || [])]
      .map(cleanText)
      .filter(Boolean);

    const promptText = normalizePhrase(prompt);
    const visible = candidates.filter(phrase => {
      const normalized = normalizePhrase(phrase);
      return normalized && new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i').test(promptText);
    });

    return dedupeBySignature([...visible, ...candidates], phrase => normalizePhrase(phrase)).slice(0, 12);
  }

  /*
    This function creates trigger phrases for a breakdown dimension. It supports common user wording such as by
    facility, each facility, by shift, and by robot class.
  */
  function dimensionTriggerPhrases(column) {
    return normalizeList(getBreakdownDimensionLexicon()[column]?.triggers || [column.replace(/_/g, ' ')]);
  }

  /*
    This function creates trigger phrases for lookup-based filters. It lets saved templates recognize facility,
    region, status, and type language later.
  */
  function lookupTriggerPhrases(ref) {
    const label = cleanText(ref.label || ref.lookupValue);
    const category = cleanText(ref.category || ref.lookupColumn).replace(/([a-z])([A-Z])/g, '$1 $2');
    const phrases = [
      label,
      `${label} facilities`,
      `${label} sites`,
      `${label} ${category}`.trim()
    ];

    return dedupeBySignature(phrases.filter(Boolean), phrase => normalizePhrase(phrase)).slice(0, 10);
  }

  /*
    This function creates trigger phrases for transaction-column filters. It lets saved templates reactivate
    filters such as shift, task, priority, and source system.
  */
  function transactionTriggerPhrases(ref) {
    const label = cleanText(ref.label || ref.sqlValue);
    const category = cleanText(ref.category || ref.sqlColumn).replace(/([a-z])([A-Z])/g, '$1 $2');
    const phrases = [
      label,
      `${label} events`,
      `${label} tasks`,
      `${label} ${category}`.trim(),
      `${category} ${label}`.trim()
    ];

    return dedupeBySignature(phrases.filter(Boolean), phrase => normalizePhrase(phrase)).slice(0, 10);
  }
/*
  This function extracts date-window phrases from the prompt. It saves the wording users actually typed so
  later template matching can recognize similar phrasing.
*/
function extractDatePhrases(prompt) {
    const text = cleanText(prompt);
    const phrases = [];
    const patterns = [
      /\b(?:last|past|prior|previous|trailing|rolling|recent)\s+\d+\s*(?:d|days?|weeks?|wks?|months?|mos?)\b/i,
      /\bin\s+the\s+(?:last|past|prior|previous)\s+\d+\s*(?:d|days?|weeks?|wks?|months?|mos?)\b/i,
      /\b(?:last|past)\s+\d+\s+days?\b/i,
      /\b(?:last|past)\s+\d+\s+months?\b/i,
      /\blast\s+(?:complete|full)\s+week\b/i,
      /\bprevious\s+(?:complete|full)\s+week\b/i,
      /\blast\s+(?:complete|full)\s+month\b/i,
      /\bprevious\s+(?:complete|full)\s+month\b/i,
      /\blast\s+(?:complete|full)\s+quarter\b/i,
      /\bprevious\s+(?:complete|full)\s+quarter\b/i,
      /\blast\s+(?:complete|full)\s+year\b/i,
      /\bprevious\s+(?:complete|full)\s+year\b/i,
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:of\s+)?20\d{2}\b/i,
      /\b(?:in|during|for)\s+20\d{2}\b/i,
      /\bmtd\b|\bmonth[-\s]?to[-\s]?date\b|\bthis\s+month\b/i,
      /\bqtd\b|\bquarter[-\s]?to[-\s]?date\b|\bthis\s+quarter\b/i,
      /\bytd\b|\byear[-\s]?to[-\s]?date\b|\bthis\s+year\b/i,
      /\bwtd\b|\bweek[-\s]?to[-\s]?date\b|\bthis\s+week\b/i,
      /\bbetween\s+\d{4}-\d{2}-\d{2}\s+(?:and|to)\s+\d{4}-\d{2}-\d{2}\b/i,
      /\bsince\s+\d{4}-\d{2}-\d{2}\b/i
    ];

    patterns.forEach(pattern => {
      const match = text.match(pattern);
      if (match) phrases.push(match[0]);
    });

    return phrases;
  }

/*
  This function converts a prompt and context into a reusable analytical signature. It captures metric keys,
  filters, breakdown columns, date window, statistic, and pattern kind.
*/
function buildIntentSignature(prompt, tierContext) {
    const metricKeys = dedupeBySignature(
      (tierContext.selectedMetrics || []).map(metric => metric.key).filter(Boolean),
      key => key
    ).sort();

    const filterDimensions = dedupeBySignature(
      (tierContext.selectedReferences || []).map(ref => ref.lookupColumn || ref.sqlColumn).filter(Boolean),
      column => column
    ).sort();

    const transactionFilterColumns = dedupeBySignature(
      (tierContext.transactionFilters || []).map(filter => filter.column).filter(Boolean),
      column => column
    ).sort();

    const promptBreakdowns = extractBreakdownColumns(prompt);
    const learnedBreakdowns = normalizeList(tierContext.breakdownColumns).map(cleanText).filter(Boolean);
    const breakdownColumns = dedupeBySignature([...promptBreakdowns, ...learnedBreakdowns], column => column).sort();
    const dateWindow = tierContext.learnedDateWindow || parseDateWindow(prompt);

    return {
      pattern: inferPatternKind(metricKeys, filterDimensions, breakdownColumns, dateWindow, prompt),
      metricKeys,
      metricSlot: Boolean(metricKeys.length),
      filterDimensions,
      transactionFilterColumns,
      breakdownColumns,
      dimensionSlot: Boolean(breakdownColumns.length),
      dateWindowRequired: Boolean(dateWindow),
      dateWindowKind: dateWindow?.kind || '',
      grain: breakdownColumns.length ? 'breakdown' : 'single_value',
      stat: inferStat(prompt, metricKeys)
    };
  }



  /*
    Breakdown NLP, date-window parsing, and prompt intent classification.
  */

  /*
    This function detects requested breakdown dimensions in natural language. It uses the dimension lexicon so
    phrases like each facility, by shift, and per robot class map to safe columns.
  */
  function extractBreakdownColumns(prompt) {
    const text = normalizePhrase(prompt);
    if (!text) return [];

    const lexicon = getBreakdownDimensionLexicon();
    const columns = [];

    Object.entries(lexicon).forEach(([column, spec]) => {
      const triggers = normalizeList(spec.triggers);
      const nouns = normalizeList(spec.nouns);

      const explicitTrigger = triggers.some(phrase => phraseMatchesTextWindow(text, phrase));
      const syntacticTrigger = nouns.some(noun => breakdownSyntaxMatches(text, noun));

      if (explicitTrigger || syntacticTrigger) columns.push(column);
    });

    const resolved = dedupeBySignature(columns, column => column);
    const hasRobotClass = resolved.includes('robot_class');
    const hasRobotId = resolved.includes('robot_id');
    const explicitRobotId = /\b(?:robot|bot)\s+id\b|\b(?:each|every|individual|per)\s+(?:robot|bot)s?\b|\bby\s+(?:robot|bot)s?\b(?!\s+(?:class|type|model))/.test(text);

    if (hasRobotClass && hasRobotId && !explicitRobotId) {
      return resolved.filter(column => column !== 'robot_id');
    }

    return resolved;
  }

  /*
    This function defines the supported breakdown nouns, aliases, and transaction columns. It is the linguistic
    bridge between how users type dimensions and how SQL must reference them.
  */
  function getBreakdownDimensionLexicon() {
    return {
      facility_id: {
        nouns: ['facility', 'facilities', 'site', 'sites', 'dc', 'dcs', 'distribution center', 'distribution centers', 'warehouse', 'warehouses', 'fulfillment center', 'fulfillment centers', 'location', 'locations', 'node', 'nodes', 'building', 'buildings'],
        triggers: ['by facility', 'per facility', 'each facility', 'every facility', 'for each facility', 'for every facility', 'facility breakdown', 'facility-level', 'facility level', 'by site', 'per site', 'each site', 'every site', 'site breakdown', 'by dc', 'per dc', 'each dc', 'every dc', 'by warehouse', 'per warehouse', 'each warehouse', 'every warehouse', 'compare facilities', 'compare across facilities', 'across facilities']
      },
      robot_id: {
        nouns: ['robot', 'robots', 'bot', 'bots', 'robot id', 'bot id', 'machine', 'machines', 'unit', 'units'],
        triggers: ['by robot', 'per robot', 'each robot', 'every robot', 'for each robot', 'robot breakdown', 'robot-level', 'robot level', 'by bot', 'per bot', 'each bot', 'every bot', 'compare robots', 'across robots']
      },
      robot_class: {
        nouns: ['robot class', 'robot classes', 'robot type', 'robot types', 'bot class', 'bot classes', 'bot type', 'bot types', 'class', 'classes', 'model', 'models'],
        triggers: ['by robot class', 'per robot class', 'each robot class', 'every robot class', 'robot class breakdown', 'by robot type', 'per robot type', 'each robot type', 'by bot type', 'per bot type', 'by class', 'per class', 'by model', 'per model']
      },
      shift_name: {
        nouns: ['shift', 'shifts', 'day shift', 'night shift', 'swing shift'],
        triggers: ['by shift', 'per shift', 'each shift', 'every shift', 'for each shift', 'shift breakdown', 'shift-level', 'shift level', 'across shifts', 'compare shifts']
      },
      task_type: {
        nouns: ['task', 'tasks', 'task type', 'task types', 'work type', 'work types', 'activity', 'activities', 'operation', 'operations', 'process', 'processes'],
        triggers: ['by task', 'per task', 'each task', 'every task', 'by task type', 'per task type', 'each task type', 'task breakdown', 'task-type breakdown', 'by activity', 'per activity', 'by operation', 'per operation', 'by process', 'per process']
      },
      task_status: {
        nouns: ['status', 'statuses', 'task status', 'task statuses', 'result', 'results', 'outcome', 'outcomes'],
        triggers: ['by status', 'per status', 'each status', 'every status', 'by task status', 'per task status', 'task status breakdown', 'by result', 'per result', 'by outcome', 'per outcome']
      },
      assigned_priority: {
        nouns: ['priority', 'priorities', 'assigned priority', 'priority level', 'priority levels'],
        triggers: ['by priority', 'per priority', 'each priority', 'every priority', 'priority breakdown', 'by assigned priority', 'per assigned priority', 'by priority level', 'per priority level']
      },
      source_system: {
        nouns: ['source', 'sources', 'source system', 'source systems', 'system', 'systems', 'feed', 'feeds', 'data source', 'data sources'],
        triggers: ['by source', 'per source', 'each source', 'every source', 'by source system', 'per source system', 'source system breakdown', 'by system', 'per system', 'by feed', 'per feed', 'by data source', 'per data source']
      },
      failure_reason_code: {
        nouns: ['failure reason', 'failure reasons', 'failure code', 'failure codes', 'reason code', 'reason codes', 'reason', 'reasons'],
        triggers: ['by failure reason', 'per failure reason', 'each failure reason', 'failure reason breakdown', 'by failure code', 'per failure code', 'by reason code', 'per reason code', 'by reason', 'per reason']
      },
      task_failed_flag: {
        nouns: ['failure flag', 'failed flag', 'task failed flag', 'failed vs not failed'],
        triggers: ['by failure flag', 'per failure flag', 'by failed flag', 'failed vs not failed', 'by task failed flag']
      },
      sla_breached_flag: {
        nouns: ['sla flag', 'sla breach flag', 'sla breached flag', 'breached vs not breached'],
        triggers: ['by sla flag', 'per sla flag', 'by sla breach flag', 'by sla breached flag', 'breached vs not breached']
      },
      maintenance_ticket_flag: {
        nouns: ['maintenance ticket', 'maintenance tickets', 'ticket flag', 'maintenance flag'],
        triggers: ['by maintenance ticket', 'per maintenance ticket', 'by ticket flag', 'by maintenance flag']
      },
      near_miss_flag: {
        nouns: ['near miss', 'near misses', 'near miss flag'],
        triggers: ['by near miss', 'per near miss', 'by near miss flag', 'near miss breakdown']
      },
      quality_issue_flag: {
        nouns: ['quality issue', 'quality issues', 'quality flag'],
        triggers: ['by quality issue', 'per quality issue', 'by quality flag', 'quality issue breakdown']
      }
    };
  }

  /*
    This function tests whether a noun appears in a breakdown-style phrase. It focuses on user wording like by,
    per, each, every, across, grouped by, split by, and broken down by.
  */
  function breakdownSyntaxMatches(text, noun) {
    const n = normalizePhrase(noun);
    if (!text || !n) return false;

    const escaped = escapeRegExp(n);
    const patterns = [
      `\\bby\\s+(?:each\\s+|every\\s+|individual\\s+|all\\s+)?${escaped}\\b`,
      `\\bper\\s+(?:each\\s+|every\\s+|individual\\s+)?${escaped}\\b`,
      `\\b(?:each|every|individual)\\s+${escaped}\\b`,
      `\\bfor\\s+(?:each|every|individual)\\s+${escaped}\\b`,
      `\\bof\\s+(?:each|every|individual)\\s+${escaped}\\b`,
      `\\bto\\s+(?:each|every|individual)\\s+${escaped}\\b`,
      `\\bgroup(?:ed)?\\s+by\\s+${escaped}\\b`,
      `\\bsplit\\s+by\\s+${escaped}\\b`,
      `\\bsegmented\\s+by\\s+${escaped}\\b`,
      `\\bdivide(?:d)?\\s+by\\s+${escaped}\\b`,
      `\\bbroken\\s+out\\s+by\\s+${escaped}\\b`,
      `\\bbreak\\s*down\\s+by\\s+${escaped}\\b`,
      `\\bbreakdown\\s+by\\s+${escaped}\\b`,
      `\\broll(?:ed)?\\s+up\\s+by\\s+${escaped}\\b`,
      `\\b${escaped}\\s+(?:breakdown|split|grouping|groups|view|level|level view|rollup|roll up)\\b`,
      `\\b${escaped}-level\\b`,
      `\\bcompare\\s+(?:across|by)?\\s*${escaped}\\b`,
      `\\bacross\\s+(?:each\\s+|every\\s+|individual\\s+)?${escaped}\\b`
    ];

    return patterns.some(pattern => new RegExp(pattern, 'i').test(text));
  }

  /*
    This function checks whether a saved dimension trigger matches the current prompt. It supports both direct
    phrase matches and breakdown syntax matches for the trigger noun.
  */
  function dimensionTriggerMatchesPrompt(trigger, prompt) {
    const column = cleanText(trigger?.column);
    if (!column) return false;

    const promptBreakdowns = extractBreakdownColumns(prompt);
    if (promptBreakdowns.includes(column)) return true;

    const text = normalizePhrase(prompt);
    return normalizeList(trigger?.phrases).some(phrase => {
      const normalized = normalizePhrase(phrase);
      if (!normalized) return false;
      return phraseMatchesTextWindow(text, normalized) && breakdownSyntaxMatches(text, normalized);
    });
  }

/*
  This function classifies the analytical shape of a request. It distinguishes metric values, metric-by-
  dimension requests, filtered metrics, date trends, and broader exploratory patterns.
*/
function inferPatternKind(metricKeys, filterDimensions, breakdownColumns, dateWindow, prompt) {
    const hasMetric = metricKeys.length > 0;
    const hasFilter = filterDimensions.length > 0;
    const hasBreakdown = breakdownColumns.length > 0;
    const asksCount = /\bhow many|count|total\s+(?:events|tasks|records)|events?\b/i.test(prompt);

    if (hasMetric && hasBreakdown && dateWindow) return 'metric_by_dimension_date_window';
    if (hasMetric && dateWindow) return 'metric_value_date_window';
    if (asksCount && hasFilter && dateWindow && hasBreakdown) return 'count_filter_by_dimension_date_window';
    if (asksCount && hasFilter && dateWindow) return 'count_filter_date_window';
    if (asksCount && dateWindow) return 'count_date_window';
    if (hasMetric && hasBreakdown) return 'metric_by_dimension';
    if (hasMetric) return 'metric_value';
    return 'general_sql_pattern';
  }

/*
  This function infers the requested statistic from the prompt. It maps wording such as average, total, count,
  rate, maximum, minimum, top, and latest to a stable stat label.
*/
function inferStat(prompt, metricKeys) {
    const text = normalizePhrase(prompt);
    if (/\baverage|avg|mean\b/i.test(text)) return 'average';
    if (/\btotal|sum\b/i.test(text)) return 'total';
    if (/\bhow many|count|number of\b/i.test(text)) return 'count';
    if (metricKeys.length) return 'value';
    return 'count';
  }

/*
  This function parses common date-window language from a prompt. It supports relative periods, trailing
  windows, today, yesterday, this week, last week, this month, last month, and absolute dates.
*/
function parseDateWindow(prompt) {
    const text = cleanText(prompt).toLowerCase();
    const now = new Date();
    const monthNames = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };
    const monthPattern = Object.keys(monthNames).join('|');

    const monthMatch = text.match(new RegExp(`\\b(${monthPattern})\\s+(?:of\\s+)?(20\\d{2})\\b`, 'i'));
    if (monthMatch) {
      const year = Number(monthMatch[2]);
      const month = monthNames[monthMatch[1].toLowerCase()];
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 1);
      return {
        kind: 'explicit_month_year',
        start: formatDateIso(start),
        end: formatDateIso(end),
        label: `${monthMatch[1]} ${year}`,
        dateColumn: 'event_date',
        dynamic: false,
        slots: { month: month + 1, year }
      };
    }

    const yearMatch = text.match(/\b(?:in|during|for)\s+(20\d{2})\b/i);
    if (yearMatch && !monthMatch) {
      const year = Number(yearMatch[1]);
      return {
        kind: 'explicit_year',
        start: `${year}-01-01`,
        end: `${year + 1}-01-01`,
        label: String(year),
        dateColumn: 'event_date',
        dynamic: false,
        slots: { year }
      };
    }

    const betweenMatch = text.match(/\bbetween\s+(\d{4}-\d{2}-\d{2})\s+(?:and|to)\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (betweenMatch) {
      return {
        kind: 'between_dates',
        start: betweenMatch[1],
        end: betweenMatch[2],
        label: `${betweenMatch[1]} to ${betweenMatch[2]}`,
        dateColumn: 'event_date',
        dynamic: false
      };
    }

    const sinceMatch = text.match(/\bsince\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (sinceMatch) {
      return {
        kind: 'since_date',
        start: sinceMatch[1],
        end: formatDateIso(now),
        label: `since ${sinceMatch[1]}`,
        dateColumn: 'event_date',
        dynamic: false
      };
    }

    const relativeWindow = parseRelativeDateWindowText(text, now);
    if (relativeWindow) return relativeWindow;

    const lastDays = text.match(/\b(?:last|past)\s+(\d+)\s+days?\b/i);
    if (lastDays) {
      const n = Math.max(1, Math.min(366, Number(lastDays[1])));
      return {
        kind: 'last_n_days',
        n,
        start: formatDateIso(addDays(now, -n)),
        end: formatDateIso(now),
        label: `last ${n} days`,
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    const lastMonths = text.match(/\b(?:last|past)\s+(\d+)\s+months?\b/i);
    if (lastMonths) {
      const n = Math.max(1, Math.min(24, Number(lastMonths[1])));
      return {
        kind: 'last_n_months',
        n,
        start: formatDateIso(addMonths(now, -n)),
        end: formatDateIso(now),
        label: `last ${n} months`,
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\blast\s+(?:complete|full)\s+week\b|\bprevious\s+(?:complete|full)\s+week\b/i.test(text)) {
      return {
        kind: 'last_complete_week',
        label: 'last complete week',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\blast\s+(?:complete|full)\s+month\b|\bprevious\s+(?:complete|full)\s+month\b/i.test(text)) {
      return {
        kind: 'last_complete_month',
        label: 'last complete month',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\blast\s+(?:complete|full)\s+quarter\b|\bprevious\s+(?:complete|full)\s+quarter\b/i.test(text)) {
      return {
        kind: 'last_complete_quarter',
        label: 'last complete quarter',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\blast\s+(?:complete|full)\s+year\b|\bprevious\s+(?:complete|full)\s+year\b/i.test(text)) {
      return {
        kind: 'last_complete_year',
        label: 'last complete year',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\bthis\s+week\b|\bwtd\b|\bweek[-\s]?to[-\s]?date\b/i.test(text)) {
      return {
        kind: 'week_to_date',
        label: 'week to date',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\bthis\s+month\b|\bmtd\b|\bmonth[-\s]?to[-\s]?date\b/i.test(text)) {
      return {
        kind: 'month_to_date',
        label: 'month to date',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\bthis\s+quarter\b|\bqtd\b|\bquarter[-\s]?to[-\s]?date\b/i.test(text)) {
      return {
        kind: 'quarter_to_date',
        label: 'quarter to date',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\bthis\s+year\b|\bytd\b|\byear[-\s]?to[-\s]?date\b/i.test(text)) {
      return {
        kind: 'year_to_date',
        label: 'year to date',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    return null;
  }



  /*
    This function parses relative date ranges from already normalized text. It handles compact and long-form
    phrases such as last 14 days, trailing two weeks, and prior 7d.
  */
  function parseRelativeDateWindowText(text, now) {
    const numberPattern = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty one|twenty two|twenty three|twenty four|twenty five|twenty six|twenty seven|twenty eight|twenty nine|thirty|sixty|ninety)';
    const relative = new RegExp(`\\b(?:last|past|prior|previous|trailing|rolling|recent)\\s+${numberPattern}\\s*(d|day|days|wk|wks|week|weeks|mo|mos|month|months)\\b`, 'i').exec(text)
      || new RegExp(`\\bin\\s+the\\s+(?:last|past|prior|previous)\\s+${numberPattern}\\s*(d|day|days|wk|wks|week|weeks|mo|mos|month|months)\\b`, 'i').exec(text);

    if (relative) {
      const amount = parseSmallIntegerWord(relative[1]);
      const unit = cleanText(relative[2]).toLowerCase();
      if (!amount) return null;

      if (/^(d|day|days)$/.test(unit)) {
        const n = Math.max(1, Math.min(366, amount));
        return {
          kind: 'last_n_days',
          n,
          start: formatDateIso(addDays(now, -n)),
          end: formatDateIso(now),
          label: `last ${n} days`,
          dateColumn: 'event_date',
          dynamic: true
        };
      }

      if (/^(wk|wks|week|weeks)$/.test(unit)) {
        const n = Math.max(1, Math.min(366, amount * 7));
        return {
          kind: 'last_n_days',
          n,
          start: formatDateIso(addDays(now, -n)),
          end: formatDateIso(now),
          label: `last ${amount} week${amount === 1 ? '' : 's'}`,
          dateColumn: 'event_date',
          dynamic: true
        };
      }

      if (/^(mo|mos|month|months)$/.test(unit)) {
        const n = Math.max(1, Math.min(24, amount));
        return {
          kind: 'last_n_months',
          n,
          start: formatDateIso(addMonths(now, -n)),
          end: formatDateIso(now),
          label: `last ${n} months`,
          dateColumn: 'event_date',
          dynamic: true
        };
      }
    }

    const compactDays = text.match(/\b(?:last|past|prior|previous|trailing|rolling)\s*(\d+)\s*d\b/i);
    if (compactDays) {
      const n = Math.max(1, Math.min(366, Number(compactDays[1])));
      return {
        kind: 'last_n_days',
        n,
        start: formatDateIso(addDays(now, -n)),
        end: formatDateIso(now),
        label: `last ${n} days`,
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\btoday\b/i.test(text)) {
      return {
        kind: 'today',
        start: formatDateIso(now),
        end: formatDateIso(addDays(now, 1)),
        label: 'today',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    if (/\byesterday\b/i.test(text)) {
      return {
        kind: 'yesterday',
        start: formatDateIso(addDays(now, -1)),
        end: formatDateIso(now),
        label: 'yesterday',
        dateColumn: 'event_date',
        dynamic: true
      };
    }

    return null;
  }

  /*
    This function converts small written number words into integers. It lets date parsing understand phrases
    such as last two weeks or past thirty days.
  */
  function parseSmallIntegerWord(value) {
    const text = cleanText(value).toLowerCase();
    if (/^\d+$/.test(text)) return Number(text);

    const map = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, sixty: 60, ninety: 90
    };

    if (map[text]) return map[text];

    if (text.startsWith('twenty ')) {
      const ones = map[text.replace('twenty ', '')];
      if (ones) return 20 + ones;
    }

    return 0;
  }


  /*
    This function converts a parsed date window into a safe SQL predicate. It prefers half-open intervals so
    date filters are predictable and avoid BETWEEN.
  */
  function dateWindowToSql(dateWindow, dateColumn = 'event_date') {
    if (!dateWindow) throw new Error('A date window is required.');
    const col = `DATE(o.${cleanText(dateColumn || dateWindow.dateColumn || 'event_date')})`;

    switch (dateWindow.kind) {
      case 'last_n_days':
        return `${col} >= DATE_SUB(CURRENT_DATE(), INTERVAL ${Number(dateWindow.n) || 7} DAY) AND ${col} < CURRENT_DATE()`;
      case 'last_n_months':
        return `${col} >= DATE_SUB(CURRENT_DATE(), INTERVAL ${Number(dateWindow.n) || 1} MONTH) AND ${col} < CURRENT_DATE()`;
      case 'last_complete_week':
        return `${col} >= DATE_SUB(DATE_SUB(CURRENT_DATE(), INTERVAL WEEKDAY(CURRENT_DATE()) DAY), INTERVAL 7 DAY) AND ${col} < DATE_SUB(CURRENT_DATE(), INTERVAL WEEKDAY(CURRENT_DATE()) DAY)`;
      case 'last_complete_month':
        return `${col} >= DATE_FORMAT(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), '%Y-%m-01') AND ${col} < DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')`;
      case 'last_complete_quarter':
        return `${col} >= DATE_SUB(STR_TO_DATE(CONCAT(YEAR(CURRENT_DATE()), '-', LPAD(((QUARTER(CURRENT_DATE()) - 1) * 3) + 1, 2, '0'), '-01'), '%Y-%m-%d'), INTERVAL 3 MONTH) AND ${col} < STR_TO_DATE(CONCAT(YEAR(CURRENT_DATE()), '-', LPAD(((QUARTER(CURRENT_DATE()) - 1) * 3) + 1, 2, '0'), '-01'), '%Y-%m-%d')`;
      case 'last_complete_year':
        return `${col} >= DATE_SUB(DATE_FORMAT(CURRENT_DATE(), '%Y-01-01'), INTERVAL 1 YEAR) AND ${col} < DATE_FORMAT(CURRENT_DATE(), '%Y-01-01')`;
      case 'today':
        return `${col} >= CURRENT_DATE() AND ${col} < DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)`;
      case 'yesterday':
        return `${col} >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) AND ${col} < CURRENT_DATE()`;
      case 'week_to_date':
        return `${col} >= DATE_SUB(CURRENT_DATE(), INTERVAL WEEKDAY(CURRENT_DATE()) DAY) AND ${col} < CURRENT_DATE()`;
      case 'month_to_date':
        return `${col} >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01') AND ${col} < CURRENT_DATE()`;
      case 'quarter_to_date':
        return `${col} >= STR_TO_DATE(CONCAT(YEAR(CURRENT_DATE()), '-', LPAD(((QUARTER(CURRENT_DATE()) - 1) * 3) + 1, 2, '0'), '-01'), '%Y-%m-%d') AND ${col} < CURRENT_DATE()`;
      case 'year_to_date':
        return `${col} >= DATE_FORMAT(CURRENT_DATE(), '%Y-01-01') AND ${col} < CURRENT_DATE()`;
      default:
        if (!dateWindow.start || !dateWindow.end) throw new Error('The date window is missing start or end.');
        return `${col} >= DATE('${escapeSqlLiteral(dateWindow.start)}') AND ${col} < DATE('${escapeSqlLiteral(dateWindow.end)}')`;
    }
  }

  /*
    This function creates reusable trigger phrases for a parsed date window. It helps template matching
    recognize equivalent future windows.
  */
  function dateWindowTriggerPhrases(dateWindow, prompt) {
    const phrases = [dateWindow?.label, ...extractDatePhrases(prompt)].filter(Boolean);
    const kindMap = {
      last_complete_week: ['last complete week', 'last full week', 'previous full week'],
      last_complete_month: ['last complete month', 'last full month', 'previous full month'],
      last_complete_quarter: ['last complete quarter', 'last full quarter', 'previous full quarter'],
      last_complete_year: ['last complete year', 'last full year', 'previous full year'],
      month_to_date: ['mtd', 'month to date', 'this month'],
      quarter_to_date: ['qtd', 'quarter to date', 'this quarter'],
      year_to_date: ['ytd', 'year to date', 'this year'],
      week_to_date: ['wtd', 'week to date', 'this week'],
      explicit_month_year: ['in month year', 'during month year', 'for month year'],
      explicit_year: ['in year', 'during year', 'for year']
    };

    return dedupeBySignature([...phrases, ...(kindMap[dateWindow?.kind] || [])], phrase => normalizePhrase(phrase));
  }

  /*
    This function selects the date column that should be used for the current metrics. It falls back to
    event_date when metrics do not specify a date column.
  */
  function getDateColumnForMetrics(metrics) {
    const found = normalizeList(metrics).map(metric => cleanText(metric.dateColumn)).find(Boolean);
    return found || 'event_date';
  }

  /*
    This function formats a Date object as an ISO calendar date. It is used when SQL predicates need stable date
    literals.
  */
  function formatDateIso(date) {
    return date.toISOString().slice(0, 10);
  }

  /*
    This function returns a new Date shifted by a number of days. It avoids mutating the input Date while
    calculating time windows.
  */
  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  /*
    This function returns a new Date shifted by a number of months. It avoids mutating the input Date while
    calculating month windows.
  */
  function addMonths(date, months) {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
  }
/*
  Learned-template matching, scoring, and SQL rendering.
*/

/*
  This function replaces concrete SQL clauses with reusable template placeholders. It is the safety layer that
  turns one successful query into a controlled pattern.
*/
function generalizeSqlTemplate(sql, tierContext, dateWindow) {
    let template = cleanText(sql);

    if (dateWindow) {
      template = template.replace(/\bDATE\s*\(\s*o\.event_date\s*\)\s*>=\s*DATE_SUB\s*\([^)]*CURRENT_DATE\(\)[^)]*\)\s*AND\s*DATE\s*\(\s*o\.event_date\s*\)\s*<\s*(?:CURRENT_DATE\(\)|DATE_SUB\s*\([^)]*CURRENT_DATE\(\)[^)]*\)|DATE_FORMAT\s*\([^)]*\))/gi, '{{date_filter}}');
      if (dateWindow.start) template = template.replace(new RegExp(`DATE\\('${escapeRegExp(dateWindow.start)}'\\)`, 'g'), "DATE('{{start_date}}')");
      if (dateWindow.end) template = template.replace(new RegExp(`DATE\\('${escapeRegExp(dateWindow.end)}'\\)`, 'g'), "DATE('{{end_date}}')");
      template = template.replace(/DATE_SUB\s*\(\s*CURRENT_DATE\(\)\s*,\s*INTERVAL\s+\d+\s+DAY\s*\)/gi, "DATE('{{start_date}}')");
      template = template.replace(/DATE_SUB\s*\(\s*CURRENT_DATE\(\)\s*,\s*INTERVAL\s+\d+\s+MONTH\s*\)/gi, "DATE('{{start_date}}')");
      template = template.replace(/(<\s*)CURRENT_DATE\(\)/gi, "$1DATE('{{end_date}}')");
      template = template.replace(/(<\s*)DATE\s*\(\s*CURRENT_DATE\(\)\s*\)/gi, "$1DATE('{{end_date}}')");
    }

    (tierContext.transactionFilters || []).forEach(filter => {
      const column = cleanText(filter.column);
      if (!column || !Array.isArray(filter.values) || !filter.values.length) return;

      const inPattern = new RegExp(`o\\.${escapeRegExp(column)}\\s+IN\\s*\\([^\\)]*\\)`, 'i');
      const eqPattern = new RegExp(`o\\.${escapeRegExp(column)}\\s*=\\s*'[^']*'`, 'i');

      if (inPattern.test(template)) template = template.replace(inPattern, `o.${column} IN ({{${column}_list}})`);
      else if (eqPattern.test(template)) template = template.replace(eqPattern, `o.${column} = {{${column}_sql}}`);
    });

    return template.replace(/\bLIMIT\s+\d+\b/i, 'LIMIT {{max_rows}}');
  }



  /*
    This function finds the best learned template for the current prompt and context. It returns a match only
    when scoring clears the configured threshold and no earlier user-confirmed gate is pending.
  */
  function findTemplateMatch(prompt, tierContext) {
    if (!state.templates.length) return null;

    const current = buildIntentSignature(prompt, tierContext);
    let best = null;

    state.templates.forEach(template => {
      const score = scoreTemplate(template, current, prompt);
      if (!best || score > best.score) best = { template, score };
    });

    return best && best.score >= Number(state.config.templateMatchThreshold || 78) ? best : null;
  }
/*
  This function scores a learned template against the current intent signature. It rewards compatible metrics,
  date windows, statistics, patterns, dimensions, filters, and trigger phrases.
*/
function scoreTemplate(template, current, prompt) {
    const saved = template.intentSignature || {};
    const normalizedPrompt = normalizePhrase(prompt);

    if (template.normalizedPrompt && template.normalizedPrompt === normalizedPrompt) return 100;
    if (normalizeList(template.matchPhrases).some(phrase => normalizePhrase(phrase) === normalizedPrompt)) return 100;
    if (normalizeList(template.triggerMap?.exactPrompts).some(phrase => normalizePhrase(phrase) === normalizedPrompt)) return 100;

    let score = 0;

    const savedMetrics = normalizeList(saved.metricKeys);
    const savedFilters = normalizeList(saved.filterDimensions);
    const savedRequiredFilters = normalizeList(saved.requiredTransactionFilterColumns);
    const savedBreakdowns = normalizeList(saved.breakdownColumns);
    const currentMetrics = normalizeList(current.metricKeys);
    const currentFilters = normalizeList(current.filterDimensions);
    const currentBreakdowns = normalizeList(current.breakdownColumns);
    const currentTransactionFilters = normalizeList(current.requiredTransactionFilterColumns || current.transactionFilterColumns);

    const savedNeedsMetric = Boolean(saved.metricSlot || savedMetrics.length);
    const savedNeedsDimension = Boolean(saved.dimensionSlot || savedBreakdowns.length);

    if (savedNeedsMetric && !currentMetrics.length) return 0;
    if (savedNeedsDimension && !currentBreakdowns.length) return 0;
    if (!savedNeedsDimension && currentBreakdowns.length) return 0;
    if (saved.dateWindowRequired && !current.dateWindowRequired) return 0;
    if (savedFilters.length && !savedFilters.every(column => currentFilters.includes(column))) return 0;
    if (savedRequiredFilters.length && !savedRequiredFilters.every(column => currentTransactionFilters.includes(column))) return 0;

    if (saved.metricSlot && currentMetrics.length) score += 40;
    else if (savedMetrics.length && savedMetrics.every(key => currentMetrics.includes(key))) score += 40;
    else if (!savedMetrics.length && !currentMetrics.length) score += 20;

    if (saved.dimensionSlot && currentBreakdowns.some(column => allowedTemplateDimensionColumns().includes(column))) score += 30;
    else if (savedBreakdowns.length && savedBreakdowns.every(column => currentBreakdowns.includes(column))) score += 26;
    else if (!savedBreakdowns.length && !currentBreakdowns.length) score += 10;

    if (savedFilters.length && savedFilters.every(column => currentFilters.includes(column))) score += 24;
    if (savedRequiredFilters.length && savedRequiredFilters.every(column => currentTransactionFilters.includes(column))) score += 18;
    if (!savedFilters.length && !savedRequiredFilters.length && !currentFilters.length) score += 8;

    if (saved.dateWindowRequired && current.dateWindowRequired) score += 30;
    else if (!saved.dateWindowRequired && !current.dateWindowRequired) score += 8;

    if (saved.stat && saved.stat === current.stat) score += 8;
    if (saved.pattern && saved.pattern === current.pattern) score += 10;

    score += scoreTemplateTriggers(template.triggerMap, prompt, current);

    const phraseScore = Math.min(14, normalizeList(template.matchPhrases).reduce((max, phrase) => {
      return Math.max(max, tokenOverlapScore(prompt, phrase));
    }, 0) * 1.4);

    return Math.min(100, Math.round(score + phraseScore));
  }


  /*
    This function scores the trigger-map portion of a learned template. It gives extra credit when saved metric,
    dimension, filter, or date phrases appear in the current prompt.
  */
  function scoreTemplateTriggers(triggerMap, prompt, current) {
    if (!triggerMap) return 0;

    let score = 0;

    normalizeList(triggerMap.metrics).forEach(trigger => {
      if (triggerMatchesPrompt(trigger, prompt) && (!trigger.metricKey || current.metricKeys.includes(trigger.metricKey))) score += 12;
    });

    normalizeList(triggerMap.dimensions).forEach(trigger => {
      if (dimensionTriggerMatchesPrompt(trigger, prompt) && (!trigger.column || current.breakdownColumns.includes(trigger.column))) score += 8;
    });

    normalizeList(triggerMap.lookupFilters).forEach(trigger => {
      if (triggerMatchesPrompt(trigger, prompt) && (!trigger.lookupColumn || current.filterDimensions.includes(trigger.lookupColumn))) score += 10;
    });

    normalizeList(triggerMap.transactionFilters).forEach(trigger => {
      if (triggerMatchesPrompt(trigger, prompt) && (!trigger.column || current.filterDimensions.includes(trigger.column))) score += 10;
    });

    normalizeList(triggerMap.dateWindows).forEach(trigger => {
      if (triggerMatchesPrompt(trigger, prompt)) score += 6;
    });

    return Math.min(28, score);
  }


  /*
    This function computes a simple normalized token-overlap score between two phrases. It is used as a
    lightweight fallback matcher for template phrases.
  */
  function tokenOverlapScore(a, b) {
    const aa = new Set(normalizePhrase(a).split(/\s+/).filter(Boolean));
    const bb = new Set(normalizePhrase(b).split(/\s+/).filter(Boolean));
    if (!aa.size || !bb.size) return 0;

    let overlap = 0;
    aa.forEach(token => { if (bb.has(token)) overlap += 1; });
    return Math.round((overlap / Math.max(aa.size, bb.size)) * 10);
  }
/*
  This function renders a matched learned template into SQL for the current prompt. It fills only controlled
  metric, date, dimension, and filter placeholders.
*/
function renderTemplateSql(template, prompt, tierContext) {
    let sql = cleanText(template.sqlTemplate);

    if (!sql) throw new Error('Saved pattern has no SQL template.');

    if (sql.includes('{{metric_selects}}') || sql.includes('{{where_clause}}') || sql.includes('{{dimension_column}}') || sql.includes('{{dimension_selects}}') || sql.includes('{{dimension_group_by}}')) {
      const metrics = getMetricsForTemplate(template, prompt, tierContext);
      const dimensionColumn = getDimensionForTemplate(template, prompt, tierContext);
      const whereClause = renderWhereClauseForTemplate(template, prompt, tierContext, metrics);

      sql = sql.replace(/\{\{metric_selects\}\}/g, renderMetricSelectsForTemplate(template, prompt, tierContext));
      sql = sql.replace(/o\.\{\{dimension_column\}\}/g, dimensionColumn ? `o.${dimensionColumn}` : '');
      sql = sql.replace(/\{\{dimension_column\}\}/g, dimensionColumn);
      sql = sql.replace(/\{\{dimension_selects\}\}/g, renderDimensionSelectsForTemplate(template, prompt, tierContext));
      sql = sql.replace(/\{\{dimension_group_by\}\}/g, renderDimensionGroupByForTemplate(template, prompt, tierContext));
      sql = sql.replace(/\{\{where_clause\}\}/g, whereClause);
    }

    const dateWindow = parseDateWindow(prompt) || tierContext.learnedDateWindow;

    if (sql.includes('{{date_filter}}')) {
      if (!dateWindow) throw new Error('Template requires a date window.');
      sql = sql.replace(/\{\{date_filter\}\}/g, dateWindowToSql(dateWindow, getDateColumnForMetrics(getMetricsForTemplate(template, prompt, tierContext))));
    }

    if (sql.includes('{{start_date}}') || sql.includes('{{end_date}}')) {
      if (!dateWindow) throw new Error('Template requires a date window.');
      sql = sql.replace(/\{\{start_date\}\}/g, dateWindow.start || '');
      sql = sql.replace(/\{\{end_date\}\}/g, dateWindow.end || '');
    }

    (tierContext.transactionFilters || []).forEach(filter => {
      const column = cleanText(filter.column);
      const values = normalizeList(filter.values).map(cleanText).filter(Boolean);
      if (!column || !values.length) return;

      sql = sql.replace(new RegExp(`\\{\\{${escapeRegExp(column)}_list\\}\\}`, 'g'), formatSqlList(values));
      sql = sql.replace(new RegExp(`\\{\\{${escapeRegExp(column)}_sql\\}\\}`, 'g'), `'${escapeSqlLiteral(values[0])}'`);
    });

    sql = sql.replace(/\{\{max_rows\}\}/g, String(normalizeMaxRows(state.config.maxRows)));
    sql = sql.replace(/\s+/g, ' ').trim();

    if (/\{\{[^}]+\}\}/.test(sql)) throw new Error('Template slots could not be resolved.');
    return sql;
  }

  /*
    This function formats an array of values as a safe SQL literal list. It is used for IN filters generated
    from resolved references.
  */
  function formatSqlList(values) {
    return values.map(value => `'${escapeSqlLiteral(value)}'`).join(', ');
  }

  /*
    This function escapes one value for safe inclusion as a SQL string literal. It doubles single quotes to
    prevent malformed SQL.
  */
  function escapeSqlLiteral(value) {
    return cleanText(value).replace(/'/g, "''");
  }

  /*
    DAISY-style playbook title and description matching.
  */

  /*
    This function normalizes playbook titles, descriptions, and prompts for DAISY-style matching. It removes
    punctuation noise while preserving meaningful words.
  */
  function normalizeForPlaybookMatch(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /*
    This function tokenizes normalized playbook text while removing stopwords. It keeps operational terms that
    make title and description matching more precise.
  */
  function tokenizeMeaningfulWordsForPlaybookMatch(value) {
    const normalized = normalizeForPlaybookMatch(value);
    if (!normalized) return [];
    return normalized
      .split(' ')
      .map(word => word.trim())
      .filter(word => word.length >= 3 && !PLAYBOOK_MATCH_STOPWORDS.has(word));
  }

  /*
    This function wraps normalized playbook text with boundary spaces. It allows phrase checks to avoid
    accidental substring matches.
  */
  function packPlaybookMatchKey(normalized) {
    return cleanText(normalized).replace(/\s+/g, '');
  }

  /*
    This function builds a set of adjacent word pairs from playbook text. Bigrams capture short phrases that
    single-word overlap can miss.
  */
  function makePlaybookBigramSet(packed) {
    const value = cleanText(packed);
    if (!value) return new Set();
    if (value.length < 2) return new Set([value]);

    const out = new Set();
    for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
    return out;
  }

  /*
    This function computes Dice similarity between two sets. It gives the playbook matcher a bounded similarity
    score for title and description comparisons.
  */
  function diceSetSimilarity(leftSet, rightSet) {
    if (!(leftSet instanceof Set) || !(rightSet instanceof Set) || !leftSet.size || !rightSet.size) return 0;

    const small = leftSet.size <= rightSet.size ? leftSet : rightSet;
    const large = leftSet.size <= rightSet.size ? rightSet : leftSet;
    let intersection = 0;

    small.forEach(value => {
      if (large.has(value)) intersection += 1;
    });

    return (2 * intersection) / (leftSet.size + rightSet.size);
  }

  /*
    This function returns the shared values between two sets. It is used to explain why a playbook matched the
    prompt.
  */
  function collectSetIntersectionValues(leftSet, rightSet) {
    if (!(leftSet instanceof Set) || !(rightSet instanceof Set) || !leftSet.size || !rightSet.size) return [];

    const small = leftSet.size <= rightSet.size ? leftSet : rightSet;
    const large = leftSet.size <= rightSet.size ? rightSet : leftSet;
    const values = [];

    small.forEach(value => {
      if (large.has(value)) values.push(value);
    });

    return values;
  }

  /*
    This function prepares a playbook for matching. It builds normalized title and description word sets, bigram
    sets, and packed phrase keys.
  */
  function buildPlaybookMatchCandidate(playbook) {
    const title = cleanText(playbook?.title);
    const description = cleanText(playbook?.description);
    const titleWords = tokenizeMeaningfulWordsForPlaybookMatch(title);
    const descriptionWords = tokenizeMeaningfulWordsForPlaybookMatch(description);
    const words = Array.from(new Set([...titleWords, ...descriptionWords]));

    if (!words.length) return null;

    const packed = packPlaybookMatchKey(normalizeForPlaybookMatch(`${title} ${description}`));
    if (packed.length < 3) return null;

    return {
      playbook,
      title,
      description,
      wordSet: new Set(words),
      titleWordSet: new Set(titleWords),
      descriptionWordSet: new Set(descriptionWords),
      bigramSet: makePlaybookBigramSet(packed)
    };
  }

  /*
    This function scores one playbook candidate against the current prompt. It combines title phrase matches,
    description overlap, meaningful word overlap, and bigram similarity.
  */
  function scorePlaybookMatchCandidate(queryWordSet, queryBigrams, candidate) {
    if (!(queryWordSet instanceof Set) || !queryWordSet.size || !candidate?.wordSet?.size) {
      return { score: 0, overlapTerms: [] };
    }

    const overlapTerms = collectSetIntersectionValues(queryWordSet, candidate.wordSet);
    if (overlapTerms.length < PLAYBOOK_MATCH_MIN_OVERLAP) return { score: 0, overlapTerms: [] };

    const coverage = overlapTerms.length / Math.max(1, queryWordSet.size);
    const bigramScore = diceSetSimilarity(queryBigrams, candidate.bigramSet);
    const titleBoost = overlapTerms.filter(term => candidate.titleWordSet.has(term)).length >= 2 ? 0.06 : 0;
    const descriptionBoost = overlapTerms.filter(term => candidate.descriptionWordSet.has(term)).length >= 2 ? 0.04 : 0;
    const score = Math.min(1, (0.62 * coverage) + (0.28 * bigramScore) + titleBoost + descriptionBoost);

    return { score, overlapTerms };
  }

  /*
    This function creates a readable reason for a playbook match. It surfaces the title and overlapping terms
    that drove the suggestion.
  */
  function buildPlaybookMatchReason(candidate, overlapTerms) {
    const overlap = normalizeList(overlapTerms).slice(0, 6);
    if (!overlap.length) return 'It uses wording similar to your question.';

    const titleHits = overlap.filter(term => candidate.titleWordSet.has(term)).slice(0, 3);
    const descriptionHits = overlap.filter(term => candidate.descriptionWordSet.has(term)).slice(0, 3);
    const format = values => values.join(', ');

    if (titleHits.length && descriptionHits.length) {
      return `Why it matched: the title and description overlap on ${format(Array.from(new Set([...titleHits, ...descriptionHits])))}.`;
    }

    if (titleHits.length) return `Why it matched: the title overlaps on ${format(titleHits)}.`;
    if (descriptionHits.length) return `Why it matched: the description overlaps on ${format(descriptionHits)}.`;
    return `Why it matched: common keywords include ${format(overlap.slice(0, 4))}.`;
  }

  /*
    This function finds the best confirmable playbook match after reference tags are cleared. It uses only title
    and description style matching so playbooks behave like DAISY rather than like learned templates.
  */
  function findPlaybookMatch(prompt) {
    if (!state.playbooks.length) return null;

    const queryWords = tokenizeMeaningfulWordsForPlaybookMatch(prompt);
    const queryWordSet = new Set(queryWords);
    if (queryWordSet.size < PLAYBOOK_MATCH_MIN_WORDS) return null;

    const queryPacked = packPlaybookMatchKey(normalizeForPlaybookMatch(prompt));
    const queryBigrams = makePlaybookBigramSet(queryPacked);
    const threshold = queryWordSet.size <= 3 ? PLAYBOOK_MATCH_SHORT_THRESHOLD : PLAYBOOK_MATCH_THRESHOLD;
    const matches = [];

    state.playbooks.forEach(playbook => {
      const candidate = buildPlaybookMatchCandidate(playbook);
      if (!candidate) return;

      const { score, overlapTerms } = scorePlaybookMatchCandidate(queryWordSet, queryBigrams, candidate);
      if (score < threshold) return;

      matches.push({
        playbook,
        score: Math.round(score * 100),
        scoreRaw: score,
        overlapTerms,
        why: buildPlaybookMatchReason(candidate, overlapTerms)
      });
    });

    matches.sort((left, right) => {
      if (right.scoreRaw !== left.scoreRaw) return right.scoreRaw - left.scoreRaw;
      const leftDate = Date.parse(cleanText(left.playbook?.updatedAt || left.playbook?.createdAt)) || 0;
      const rightDate = Date.parse(cleanText(right.playbook?.updatedAt || right.playbook?.createdAt)) || 0;
      return rightDate - leftDate;
    });

    return matches[0] || null;
  }

  /*
    This function reduces a matched playbook to model-safe context fields. It keeps title, description, prompt
    template, metric keys, score, and match reason.
  */
  function compactPlaybookForModel(playbook, score) {
    return {
      title: playbook.title,
      description: playbook.description,
      promptTemplate: playbook.promptTemplate,
      metricKeys: playbook.metricKeys || [],
      referenceHints: playbook.referenceHints || [],
      score
    };
  }

  /*
    AppDB persistence for templates and playbooks.
  */

  /*
    This function reloads learned templates and playbooks from AppDB. It keeps local Tier 3 memory current after
    saves and deletes.
  */
  async function refreshTier3Caches() {
    const [templates, playbooks] = await Promise.all([
      loadAppDbContentCollection(state.config.templatesCollection),
      loadAppDbContentCollection(state.config.playbooksCollection)
    ]);

    state.templates = templates.filter(doc => doc.type === 'template');
    state.playbooks = playbooks.filter(doc => doc.type === 'playbook');
  }

  /*
    This function builds the AppDB endpoint for a named collection. It encodes the collection path segment
    before making Domo datastore calls.
  */
  function appDbDocumentsEndpoint(collection) {
    const name = cleanText(collection);
    if (!name) throw new Error('An AppDB collection name is required.');
    return `/domo/datastores/v1/collections/${encodeURIComponent(name)}/documents`;
  }

  /*
    This function normalizes AppDB list responses into an array of document records. It supports direct arrays
    and common wrapped response shapes.
  */
  function normalizeAppDbDocumentsList(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.documents)) return raw.documents;
      if (Array.isArray(raw.results)) return raw.results;
      if (Array.isArray(raw.response)) return raw.response;
      if (Array.isArray(raw.firstMatch)) return raw.firstMatch;
      return [raw];
    }
    return [];
  }

  /*
    This function extracts a stable document id from an AppDB record. It supports multiple field names that may
    appear in Domo datastore responses.
  */
  function extractAppDbDocId(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();

    if (typeof raw === 'object') {
      const candidates = [raw.id, raw.documentId, raw.docId, raw._id];
      for (const candidate of candidates) {
        const found = extractAppDbDocId(candidate);
        if (found) return found;
      }

      if (raw.firstMatch != null) return extractAppDbDocId(raw.firstMatch);
      if (raw.results != null) return extractAppDbDocId(raw.results);
      if (raw.response != null) return extractAppDbDocId(raw.response);
    }

    return '';
  }

  /*
    This function unwraps and normalizes an AppDB content document. It preserves the document id alongside the
    stored template or playbook fields.
  */
  function normalizeAppDbContentDocument(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const content = raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content)
      ? raw.content
      : raw.doc && typeof raw.doc === 'object' && !Array.isArray(raw.doc)
        ? raw.doc
        : raw;

    if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
    if (content.id === '__index' || raw.id === '__index') return null;

    const appDbId = extractAppDbDocId(raw);
    return {
      ...content,
      __appDbId: appDbId || cleanText(content.__appDbId)
    };
  }

  /*
    This function loads all content documents for one AppDB collection. It returns normalized documents and
    fails gracefully when the collection is unavailable.
  */
  async function loadAppDbContentCollection(collection) {
    try {
      const raw = await window.domo.get(appDbDocumentsEndpoint(collection));
      return normalizeAppDbDocumentsList(raw)
        .map(normalizeAppDbContentDocument)
        .filter(Boolean);
    } catch (error) {
      console.warn(`[DEMO] Could not load AppDB collection ${collection}.`, error);
      return [];
    }
  }

  /*
    This function creates a new AppDB content document. It assigns a local id and timestamp before posting the
    document payload.
  */
  async function createAppDbContentDocument(collection, content) {
    const payload = { content };
    const raw = await window.domo.post(
      appDbDocumentsEndpoint(collection),
      payload,
      { contentType: 'application/json' }
    );

    return {
      raw,
      appDbId: extractAppDbDocId(raw)
    };
  }

  /*
    This function deletes a template or playbook document from AppDB. It uses the stored document id and ignores
    empty ids safely.
  */
  async function deleteAppDbContentDocument(collection, doc) {
    const appDbId = cleanText(doc?.__appDbId || doc?.appDbId || doc?.documentId || doc?.docId || doc?.id);
    if (!appDbId) throw new Error('An AppDB document id is required.');

    const url = `${appDbDocumentsEndpoint(collection)}/${encodeURIComponent(appDbId)}`;

    if (window.domo && typeof window.domo.delete === 'function') {
      return window.domo.delete(url);
    }

    const response = await fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin'
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AppDB delete failed (${response.status}). ${text}`);
    }

    const contentType = String(response.headers.get('content-type') || '');
    return contentType.includes('application/json') ? response.json() : response.text();
  }

  /*
    Playbook creation, menu management, runtime execution, and deletion.
  */

  /*
    This function starts the playbook-save flow from a result card. It delegates the actual title and
    description capture to the dialog builder.
  */
  function savePlaybookFromResult(result, button) {
  openSavePlaybookDialog(result, button);
}

/*
  This function opens the modal dialog that captures a playbook title and description. It keeps the saved
  playbook user-authored instead of relying on generated labels only.
*/
function openSavePlaybookDialog(result, button) {
  const defaultTitle = buildTemplateTitle(buildIntentSignature(result.prompt, result.tierContext), result.prompt);
  const backdrop = document.createElement('div');
  backdrop.className = 'save-dialog-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const dialog = document.createElement('section');
  dialog.className = 'save-dialog';

  const head = document.createElement('div');
  head.className = 'save-dialog__head';

  const copy = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Tier 3 Memory';

  const title = document.createElement('h2');
  title.textContent = 'Save Playbook';

  const sub = document.createElement('p');
  sub.textContent = 'Save this solved workflow so it can be run again from the playbooks menu.';

  copy.append(eyebrow, title, sub);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'modal-close-button';
  close.textContent = 'Close';
  close.addEventListener('click', () => backdrop.remove());

  head.append(copy, close);

  const titleLabel = document.createElement('label');
  titleLabel.className = 'save-dialog__label';
  titleLabel.textContent = 'Title';

  const titleInput = document.createElement('input');
  titleInput.className = 'save-dialog__input';
  titleInput.value = defaultTitle;

  const descLabel = document.createElement('label');
  descLabel.className = 'save-dialog__label';
  descLabel.textContent = 'Description';

  const descInput = document.createElement('textarea');
  descInput.className = 'save-dialog__textarea';
  descInput.rows = 3;
  descInput.value = `Run: ${cleanText(result.prompt).slice(0, 110)}`;

  const status = document.createElement('p');
  status.className = 'save-dialog__status';

  const actions = document.createElement('div');
  actions.className = 'save-dialog__actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost-button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => backdrop.remove());

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary-button';
  save.textContent = 'Save Playbook';

  save.addEventListener('click', async () => {
    const titleText = cleanText(titleInput.value);
    const description = cleanText(descInput.value);
    if (!titleText) {
      status.textContent = 'Add a title before saving.';
      return;
    }

    const playbook = buildPlaybookFromResult(result, titleText, description);

    try {
      save.disabled = true;
      cancel.disabled = true;
      status.textContent = 'Saving playbook...';
      const saved = await createAppDbContentDocument(state.config.playbooksCollection, playbook);
      const storedPlaybook = { ...playbook, __appDbId: saved.appDbId };
      state.playbooks = dedupeBySignature([storedPlaybook, ...state.playbooks], item => item.id);
      status.textContent = 'Playbook saved.';
      if (button) button.textContent = 'Saved';
      window.setTimeout(() => backdrop.remove(), 520);
    } catch (error) {
      console.error('[DEMO] Playbook save failed:', error);
      status.textContent = 'Playbook save failed.';
      save.disabled = false;
      cancel.disabled = false;
      if (button) button.textContent = 'Save Playbook';
    }
  });

  actions.append(cancel, save);
  dialog.append(head, titleLabel, titleInput, descLabel, descInput, status, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) backdrop.remove();
  });

  titleInput.focus();
}

  /*
    This function builds a playbook document from a successful result and user-entered metadata. It saves the
    prompt, SQL template, metrics, filters, and context needed to run it later.
  */
  function buildPlaybookFromResult(result, title, description) {
  const now = new Date().toISOString();
  const signature = buildIntentSignature(result.prompt, result.tierContext);
  const dateWindow = parseDateWindow(result.prompt);
  const triggerMap = buildTriggerMapFromResult(result, signature, dateWindow);
  const sqlTemplate = result.template?.sqlTemplate || generalizeSqlTemplate(result.sql, result.tierContext, dateWindow);
  validateSqlTemplateSafety(sqlTemplate);

  return {
    id: `pb_${safeId(title)}_${Date.now()}`,
    type: 'playbook',
    title,
    description,
    promptTemplate: cleanText(result.prompt),
    matchPhrases: buildTemplateMatchPhrases(result, triggerMap),
    metricKeys: (result.tierContext?.selectedMetrics || []).map(metric => metric.key).filter(Boolean),
    referenceHints: result.tierContext?.selectedReferences || [],
    intentSignature: signature,
    slots: buildTemplateSlots(signature),
    triggerMap,
    sqlTemplate,
    outputColumns: deriveColumns(result.rows).map(name => ({
      name,
      role: name === 'facility_id' ? 'lookup_key' : 'result',
      label: name
    })),
    mergePlan: {
      lookupAlias: 'facilities',
      transactionKey: 'facility_id',
      lookupKey: 'facility_id',
      defaultJoinColumns: ['facility_name']
    },
    createdAt: now,
    updatedAt: now
  };
}

  /*
    This function opens the playbook management modal. It loads current playbooks and renders each one with run
    and delete actions.
  */
  async function openPlaybooksMenu() {
    await refreshTier3Caches();

    closeResultsModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'results-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const modal = document.createElement('section');
    modal.className = 'results-modal playbooks-modal';

    const head = document.createElement('header');
    head.className = 'results-modal__head';

    const copy = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'results-modal__eyebrow';
    eyebrow.textContent = 'Tier 3';

    const title = document.createElement('h2');
    title.className = 'results-modal__title';
    title.textContent = 'Playbooks';

    const sub = document.createElement('p');
    sub.className = 'results-modal__sub';
    sub.textContent = 'Run or delete saved playbooks.';

    copy.append(eyebrow, title, sub);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-close-button';
    close.textContent = 'Close';
    close.addEventListener('click', closeResultsModal);

    head.append(copy, close);

    const body = document.createElement('div');
    body.className = 'playbooks-list';

    if (!state.playbooks.length) {
      const empty = document.createElement('p');
      empty.className = 'playbooks-empty';
      empty.textContent = 'No playbooks saved yet.';
      body.appendChild(empty);
    } else {
      state.playbooks.forEach(playbook => body.appendChild(createPlaybookRow(playbook)));
    }

    modal.append(head, body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    state.activeModal = { backdrop, rows: [], sort: { column: '', direction: 'asc' } };

    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) closeResultsModal();
    });

    document.addEventListener('keydown', closeResultsModalOnEscape);
    close.focus();
  }

  /*
    This function renders one saved playbook row in the management modal. It presents the title, description,
    and action buttons in a compact layout.
  */
  function createPlaybookRow(playbook) {
    const row = document.createElement('article');
    row.className = 'playbook-row';

    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = playbook.title || 'Untitled Playbook';

    const description = document.createElement('p');
    description.textContent = playbook.description || playbook.promptTemplate || 'Saved playbook.';

    copy.append(title, description);

    const actions = document.createElement('div');
    actions.className = 'playbook-row__actions';

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'primary-button';
    run.textContent = 'Run';
    run.addEventListener('click', () => runPlaybook(playbook));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost-button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deletePlaybook(playbook, row, del));

    actions.append(run, del);
    row.append(copy, actions);
    return row;
  }

  /*
    This function runs a saved playbook directly from the playbook menu. It renders the saved SQL pattern,
    executes it, displays the result, and records the interaction in chat history.
  */
  async function runPlaybook(playbook) {
    if (state.isBusy) return;

    closeResultsModal();
    state.activeTier = 'tier3';
    applyTierAvailability();
    clearComposer();

    const prompt = cleanText(playbook.promptTemplate || playbook.title || '');
    const visiblePrompt = `Run playbook: ${cleanText(playbook.title || 'Saved Playbook')}`;

    setBusy(true);
    setLlmGauge('off', 'No LLM: saved playbook running');
    addUserTurn(prompt || visiblePrompt);
    appendUserMessage(visiblePrompt);

    const maxAttempts = getMaxSqlAttempts();
    const loadingCard = appendLoadingCard(formatAttemptLabel(1, maxAttempts, 'Loading Saved Playbook...'));
    reserveScrollSpace(loadingCard, 420);
    scrollOnceForSubmittedTurn(loadingCard, 420);

    try {
      const schema = await getTransactionSchema();
      const runtimeContext = buildPlaybookRuntimeContext(playbook, prompt);
      const renderedSql = tryRenderReusablePattern(playbook, prompt, runtimeContext, schema);

      if (!renderedSql) {
        throw new Error('The saved playbook could not be rendered into safe SQL.');
      }

      let result = null;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, 'Querying Saved Playbook...'));
          const executedRows = await executeSqlWithAttemptSql(renderedSql);

          updateLoadingCard(loadingCard, formatAttemptLabel(attempt, maxAttempts, 'Preparing Results...'));
          const prepared = prepareRowsForDisplay(executedRows, runtimeContext);

          result = {
            sql: renderedSql,
            rows: prepared.rows,
            rowCount: prepared.rows.length,
            rawRowCount: executedRows.length,
            enrichment: prepared.enrichment,
            dateColumns: prepared.dateColumns,
            model: 'saved-playbook',
            tier: 'tier3',
            prompt,
            tierContext: runtimeContext,
            attemptsUsed: attempt,
            maxAttempts,
            feedback: '',
            fromTemplate: true,
            fromPlaybook: true,
            template: playbook,
            playbook
          };
          break;
        } catch (error) {
          lastError = error;
          console.warn(`[DEMO] Playbook SQL attempt ${attempt} of ${maxAttempts} failed:`, error);

          if (attempt < maxAttempts) {
            updateLoadingCard(loadingCard, formatAttemptLabel(attempt + 1, maxAttempts, 'Retrying Saved Playbook...'));
            await wait(260);
          }
        }
      }

      if (!result) throw lastError || new Error('The saved playbook failed to run.');

      state.lastResult = result;
      addAssistantTurn(`Results found: ${result.rowCount}. SQL: ${result.sql}`);
      replaceLoadingWithResult(loadingCard, result);
      dom.composerInput.focus();
    } catch (error) {
      console.error('[DEMO] Playbook run failed:', error);
      replaceLoadingWithError(loadingCard, 'The saved playbook could not run safely.');
    } finally {
      setBusy(false);
      setLlmGauge('neutral', 'LLM status: idle');
    }
  }

  /*
    This function builds the runtime context for a saved playbook execution. It starts with the current prompt
    shape and then merges saved playbook context.
  */
  function buildPlaybookRuntimeContext(playbook, prompt) {
    let context = buildTier2Context(prompt || cleanText(playbook.promptTemplate || playbook.title || ''));

    context = mergePlaybookSavedContext(context, playbook);
    applyTriggerMapToContext(playbook.triggerMap, prompt || playbook.promptTemplate || playbook.title || '', context);

    context.selectedReferences = dedupeBySignature(context.selectedReferences || [], ref => {
      return `${ref.category || ''}:${ref.sqlColumn || ref.lookupColumn || ''}:${ref.sqlValue || ref.lookupValue || ref.label}`;
    });
    context.selectedMetrics = dedupeBySignature(context.selectedMetrics || [], metric => metric.key || metric.name);
    context.transactionFilters = dedupeFilters(context.transactionFilters || []);
    context.postMergeFilters = dedupePostMergeFilters(context.postMergeFilters || []);
    context.lookupMappings = state.config.lookupMappings;

    return context;
  }

  /*
    This function merges saved playbook metrics, filters, and lookup mappings into a runtime context. It
    deduplicates each list so the model and renderer receive stable context.
  */
  function mergePlaybookSavedContext(context, playbook) {
    const next = {
      ...context,
      selectedReferences: [...(context.selectedReferences || [])],
      selectedMetrics: [...(context.selectedMetrics || [])],
      transactionFilters: [...(context.transactionFilters || [])],
      postMergeFilters: [...(context.postMergeFilters || [])]
    };

    normalizeList(playbook.referenceHints).forEach(ref => {
      next.selectedReferences.push(ref);
      if (ref.transactionFilter) next.transactionFilters.push(ref.transactionFilter);
      if (ref.postMergeFilter) next.postMergeFilters.push(ref.postMergeFilter);
      if (ref.sqlColumn && ref.sqlValue) {
        next.transactionFilters.push({
          column: ref.sqlColumn,
          values: [ref.sqlValue],
          source: ref.sourceTable || 'transactions',
          label: ref.label
        });
      }
    });

    normalizeList(playbook.metricKeys).forEach(key => {
      const metric = state.metricsCatalog.find(item => item.key === key);
      if (metric) next.selectedMetrics.push(metric);
    });

    return next;
  }

  /*
    This function deletes a saved playbook and updates the open playbook menu. It disables the row action while
    the AppDB delete request is pending.
  */
  async function deletePlaybook(playbook, row, button) {
  if (button && button.dataset.confirming !== 'true') {
    button.dataset.confirming = 'true';
    button.textContent = 'Confirm';
    window.setTimeout(() => {
      if (button && button.dataset.confirming === 'true') {
        button.dataset.confirming = 'false';
        button.textContent = 'Delete';
      }
    }, 2200);
    return;
  }

  try {
    if (button) {
      button.disabled = true;
      button.textContent = 'Deleting...';
    }

    await deleteAppDbContentDocument(state.config.playbooksCollection, playbook);
    state.playbooks = state.playbooks.filter(item => item.id !== playbook.id);
    row.remove();
  } catch (error) {
    console.error('[DEMO] Playbook delete failed:', error);
    appendErrorCard('The playbook could not be deleted.');
    if (button) {
      button.disabled = false;
      button.dataset.confirming = 'false';
      button.textContent = 'Delete';
    }
  }
}

  /*
    Application reset and first-message rendering.
  */

  /*
    This function clears the active prompt, chat memory, result state, modals, and status indicators. It
    restores the interface to its initial operator-ready state.
  */
  function resetAppToInitialState() {
    closeResultsModal();
    closeContextConfirmationModal();
    state.chatTurns = [];
    state.lastResult = null;
    state.pendingContextConfirmation = null;
    state.declinedReusableSignatures.clear();
    state.activeTier = 'tier3';
    state.activeCategory = 'metrics';
    state.searchText = '';
    setLlmGauge('neutral', 'LLM status: idle');

    clearComposer();
    dom.referenceSearch.value = '';
    dom.chatTranscript.replaceChildren(createInitialAssistantMessage());

    applyTierAvailability();
    dom.composerInput.focus();
  }

  /*
    This function builds the initial assistant greeting. It is used on first load and after a full reset.
  */
  function createInitialAssistantMessage() {
    const article = document.createElement('article');
    article.className = 'message message--assistant';

    const avatar = document.createElement('div');
    avatar.className = 'message__avatar';
    avatar.textContent = 'D';

    const body = document.createElement('div');
    body.className = 'message__body';

    const meta = document.createElement('p');
    meta.className = 'message__meta';
    meta.textContent = 'DEMO';

    const copy = document.createElement('p');
    copy.textContent = 'Hello! What operations data can I help you discover today?';

    body.append(meta, copy);
    article.append(avatar, body);
    return article;
  }


  /*
    Full-results modal rendering, sorting, and cell formatting.
  */

  /*
    This function opens the full-results modal for a result card. It derives columns, renders the sortable
    table, and registers the Escape-key close behavior.
  */
  function openResultsModal(result) {
    closeResultsModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'results-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const modal = document.createElement('section');
    modal.className = 'results-modal';

    const head = document.createElement('header');
    head.className = 'results-modal__head';

    const copy = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'results-modal__eyebrow';
    eyebrow.textContent = 'Query Result';

    const title = document.createElement('h2');
    title.className = 'results-modal__title';
    title.textContent = `${result.rowCount.toLocaleString()} Rows Returned`;

    const sub = document.createElement('p');
    sub.className = 'results-modal__sub';
    sub.textContent = buildModalSubtitle(result);

    copy.append(eyebrow, title, sub);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-close-button';
    close.textContent = 'Close';
    close.addEventListener('click', closeResultsModal);

    head.append(copy, close);

    const body = document.createElement('div');
    body.className = 'results-modal__body';

    const mount = document.createElement('div');
    mount.className = 'table-popout-mount';

    const wrap = document.createElement('div');
    wrap.className = 'table-popout-wrap';

    renderFullResultsTable(wrap, result.rows, deriveColumns(result.rows));

    mount.appendChild(wrap);
    body.appendChild(mount);
    modal.append(head, body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    state.activeModal = { backdrop, rows: result.rows, sort: { column: '', direction: 'asc' } };

    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) closeResultsModal();
    });

    document.addEventListener('keydown', closeResultsModalOnEscape);
    close.focus();
  }

  /*
    This function builds the subtitle for the full-results modal. It summarizes row count, date grain, and
    reusable pattern status.
  */
  function buildModalSubtitle(result) {
    const bits = [];
    if (result.enrichment?.addedColumns?.length) bits.push(`Lookup: ${result.enrichment.addedColumns.join(', ')}`);
    if (result.dateColumns?.length) bits.push(`Date: ${result.dateColumns.map(d => `${d.column} ${d.granularity}`).join(', ')}`);
    return bits.join(' · ') || 'Sortable row detail';
  }

  /*
    This function closes the results modal when the user presses Escape. It keeps keyboard behavior consistent
    with other modals.
  */
  function closeResultsModalOnEscape(event) {
    if (event.key === 'Escape') closeResultsModal();
  }

  /*
    This function closes the active results or playbook modal and removes its DOM. It also clears the stored
    active modal reference.
  */
  function closeResultsModal() {
    if (!state.activeModal) return;
    state.activeModal.backdrop.remove();
    state.activeModal = null;
    document.removeEventListener('keydown', closeResultsModalOnEscape);
  }

  /*
    This function renders the full result set into a sortable table. It uses derived columns and formatted cells
    so arbitrary SQL results remain readable.
  */
  function renderFullResultsTable(container, rows, columns) {
    container.replaceChildren();

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-table';
      empty.textContent = 'No rows returned.';
      container.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'popout-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    columns.forEach(column => {
      const th = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-header-button';

      const label = document.createElement('span');
      label.className = 'sort-header-label';
      label.textContent = column;

      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = getSortArrow(column);

      button.append(label, arrow);
      button.addEventListener('click', () => sortModalRows(container, column, columns));
      th.appendChild(button);
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr');
      columns.forEach(column => {
        const td = document.createElement('td');
        td.textContent = formatCell(row[column]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  }

  /*
    This function toggles sorting for a modal table column. It stores the active sort state on the table
    container and rerenders the rows.
  */
  function sortModalRows(container, column, columns) {
    if (!state.activeModal) return;

    const current = state.activeModal.sort;
    const direction = current.column === column && current.direction === 'asc' ? 'desc' : 'asc';
    state.activeModal.sort = { column, direction };

    const rows = getSortedRows(state.activeModal.rows, column, direction);
    renderFullResultsTable(container, rows, columns);
  }

  /*
    This function returns the visual sort arrow for a column. It shows ascending, descending, or unsorted state.
  */
  function getSortArrow(column) {
    if (!state.activeModal || state.activeModal.sort.column !== column) return '↕';
    return state.activeModal.sort.direction === 'asc' ? '↑' : '↓';
  }

  /*
    This function returns sorted rows for the active modal column and direction. It leaves the original rows
    untouched for repeatable toggles.
  */
  function getSortedRows(rows, column, direction) {
    const copy = [...rows];
    copy.sort((a, b) => {
      const result = compareValues(a[column], b[column]);
      return direction === 'desc' ? -result : result;
    });
    return copy;
  }

  /*
    This function compares two values for modal sorting. It treats numeric values as numbers and otherwise falls
    back to locale-aware text comparison.
  */
  function compareValues(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true });
  }

  /*
    This function derives a stable column list from result rows. It preserves first-seen order while including
    fields that may appear in later rows.
  */
  function deriveColumns(rows) {
    const seen = new Set();
    rows.forEach(row => {
      Object.keys(row || {}).forEach(key => seen.add(key));
    });

    const columns = Array.from(seen);
    if (columns.includes('facility_id') && columns.includes('facility_name')) {
      return ['facility_id', 'facility_name', ...columns.filter(col => col !== 'facility_id' && col !== 'facility_name')];
    }

    return columns;
  }

  /*
    This function formats one table cell value for display. It handles nulls, numbers, strings, booleans,
    objects, and arrays consistently.
  */
  function formatCell(value) {
    if (value == null) return '';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
    return String(value);
  }

  /*
    Busy-state handling, reference loading, and app initialization.
  */

  /*
    This function toggles the app-wide busy state. It disables send and reset controls while a workflow is
    running.
  */
  function setBusy(isBusy) {
    state.isBusy = Boolean(isBusy);
    dom.sendPromptButton.disabled = state.isBusy;
    dom.resetPromptButton.disabled = state.isBusy;
    dom.composerInput.setAttribute('aria-busy', state.isBusy ? 'true' : 'false');
    renderTierButtons();
    renderAvailabilityControls();
  }

  /*
    This function loads facility and transaction rows, rebuilds references, renders the reference UI, and
    refreshes Tier 3 memory. It is the main startup data-loading routine.
  */
  async function loadAndRenderReferences() {
    setReferenceLoading('Loading Reference Values...');

    try {
      const [facilityRows, transactionRows] = await Promise.all([
        fetchAllDomoRows(state.config.facilitiesAlias),
        fetchAllDomoRows(state.config.transactionsAlias)
      ]);

      buildReferenceState(facilityRows, transactionRows);
      renderTabs();
      applyTierAvailability();
    } catch (error) {
      console.error('[DEMO] Reference load failed:', error);
      dom.referenceList.replaceChildren();
      dom.referenceStatus.textContent = 'Reference Values Could Not Be Loaded';
    }
  }

  /*
    This function updates the reference-panel status text. It gives immediate feedback while references are
    loading or unavailable.
  */
  function setReferenceLoading(message) {
    dom.referenceStatus.textContent = message;
    dom.referenceList.replaceChildren();
  }

  /*
    This function updates the startup splash status text. It tells the user which initialization phase is
    currently running.
  */
  function setSplashStatus(message) {
    if (dom.splashStatus) dom.splashStatus.textContent = message;
  }

  /*
    This function removes the loading state from the body. It hides the splash screen after required startup
    work completes.
  */
  function markReady() {
    document.body.classList.remove('is-loading');
  }

  /*
    Small shared utility helpers.
  */

  /*
    This function safely returns an array. It prevents callers from treating null, undefined, or wrapped values
    as iterable arrays.
  */
  function normalizeList(value) {
    return Array.isArray(value) ? value : [];
  }

  /*
    This function bounds the maximum row count used by package calls and SQL limits. It keeps demo queries
    within a safe and predictable range.
  */
  function normalizeMaxRows(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 5000;
    return Math.max(1, Math.min(5000, Math.floor(n)));
  }


  /*
    This function converts unknown values into trimmed strings. It is the base sanitation helper used throughout
    the app.
  */
  function cleanText(value) {
    return String(value ?? '').trim();
  }

  /*
    This function normalizes text for exact-ish phrase comparisons. It lowercases text and collapses repeated
    whitespace.
  */
  function normalizePhrase(value) {
    return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
  }

  /*
    This function sorts reference-like items by their labels. It gives reference lists a stable alphabetical
    order.
  */
  function compareByLabel(a, b) {
    return cleanText(a.label || a.name).localeCompare(cleanText(b.label || b.name), undefined, { sensitivity: 'base', numeric: true });
  }

  /*
    This function returns unique non-empty strings from a value list. It is used when building reference lists
    and filter values.
  */
  function uniqueValues(values) {
    return Array.from(new Set((values || []).map(cleanText).filter(Boolean)));
  }

  /*
    This function converts arbitrary text into a DOM-safe id fragment. It removes punctuation and replaces it
    with hyphen separators.
  */
  function safeId(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
  }

  /*
    This function escapes text before inserting it into a regular expression. It protects user and reference
    phrases from being interpreted as regex syntax.
  */
  function escapeRegExp(value) {
    return cleanText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /*
    This function performs application startup. It caches DOM nodes, wires events, loads config and metrics,
    prepares references, updates counts, and hides the splash screen.
  */
  async function init() {
    cacheDom();
    wireEvents();
    setLlmGauge('neutral', 'LLM status: idle');

    setSplashStatus('Loading Config');
    await loadConfig();

    setSplashStatus('Loading Metrics');
    await loadMetricsCatalog();

    setSplashStatus('Preparing References');
    await loadAndRenderReferences();

    updateInsertedReferenceCount();
    window.setTimeout(markReady, 220);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
