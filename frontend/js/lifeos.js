const api = {
  async get(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  async send(path, method, body) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
};

const state = {
  types: [],
  objects: [],
  selectedObjectId: null,
  editorTypeName: null,
  activeView: "home",
  savingHomeDraft: false,
  lastSavedHomeText: "",
  reviewEditingObjectId: null,
  reviewEditLastSavedText: "",
  typeDraftFields: [],
  selectedTypeName: null,
};

const els = {
  navItems: document.querySelectorAll(".nav-item"),
  views: document.querySelectorAll(".view"),
  captureForm: document.getElementById("captureForm"),
  captureInput: document.getElementById("captureInput"),
  captureStatus: document.getElementById("captureStatus"),
  reviewBadge: document.getElementById("reviewBadge"),
  reviewQueue: document.getElementById("reviewQueue"),
  reviewBackBtn: document.getElementById("reviewBackBtn"),
  reviewFullEditor: document.getElementById("reviewFullEditor"),
  commandPalette: document.getElementById("commandPalette"),
  goalsList: document.getElementById("goalsList"),
  newGoalBtn: document.getElementById("newGoalBtn"),
  typeForm: document.getElementById("typeForm"),
  typeNameInput: document.getElementById("typeNameInput"),
  typeKindInput: document.getElementById("typeKindInput"),
  typeListItemField: document.getElementById("typeListItemField"),
  typeListItemInput: document.getElementById("typeListItemInput"),
  typeFieldNameInput: document.getElementById("typeFieldNameInput"),
  typeFieldTypeInput: document.getElementById("typeFieldTypeInput"),
  addTypeFieldBtn: document.getElementById("addTypeFieldBtn"),
  typeFieldList: document.getElementById("typeFieldList"),
  typeSubmitBtn: document.getElementById("typeSubmitBtn"),
  newTypeBtn: document.getElementById("newTypeBtn"),
  typeStatus: document.getElementById("typeStatus"),
  typeList: document.getElementById("typeList"),
  typeFilter: document.getElementById("typeFilter"),
  objectsList: document.getElementById("objectsList"),
  timelineList: document.getElementById("timelineList"),
  editorTitle: document.getElementById("editorTitle"),
  objectEditor: document.getElementById("objectEditor"),
};

function setStatus(element, message, error = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", error);
}

function titleFor(object) {
  return (
    object.fields.title ||
    object.fields.name ||
    object.fields.date ||
    object.fields.content?.split(/\n/)[0]?.slice(0, 80) ||
    "Untitled"
  );
}

function typeDef(name) {
  return state.types.find((type) => type.name === name);
}

function visibleTypes() {
  return state.types.filter((type) => type.name !== "Daily Log");
}

function primitiveNames() {
  return new Set(["Text", "Number", "Boolean", "Date", "List", "Image", "Video", "Blob"]);
}

async function showView(viewName) {
  if (state.activeView === "home" && viewName !== "home") {
    await saveHomeDraft({ silent: true });
  }
  state.activeView = viewName;
  const shell = document.querySelector(".app-shell");
  shell?.setAttribute("data-active-view", viewName);
  if (viewName !== "review") {
    exitReviewEditMode({ save: false });
  }
  els.navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });
  els.views.forEach((view) => {
    view.classList.toggle("active", view.id === `${viewName}View`);
  });
  if (viewName === "home") {
    requestAnimationFrame(() => els.captureInput.focus());
  } else if (viewName === "review") {
    if (!state.reviewEditingObjectId) selectFirstReviewItem();
  }
}

function empty(message) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = message;
  return div;
}

function renderGoals() {
  const goals = state.objects.filter((object) => object.type_name === "Goal");
  els.goalsList.replaceChildren();
  if (!goals.length) {
    els.goalsList.append(empty("No goals yet."));
    return;
  }
  goals.forEach((goal) => {
    const progress = Number(goal.fields.progress || 0);
    const card = document.createElement("article");
    card.className = "goal-card";
    card.classList.toggle("active", goal.id === state.selectedObjectId);
    card.innerHTML = `
      <div class="goal-title"></div>
      <div class="object-meta"></div>
      <div class="progress-track"><div class="progress-fill"></div></div>
    `;
    card.querySelector(".goal-title").textContent = titleFor(goal);
    card.querySelector(".object-meta").textContent = [
      `${Math.max(0, Math.min(100, progress))}%`,
      goal.fields.deadline ? `Due ${goal.fields.deadline}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    card.querySelector(".progress-fill").style.width = `${Math.max(0, Math.min(100, progress))}%`;
    card.addEventListener("click", () => selectObject(goal.id));
    els.goalsList.append(card);
  });
}

function renderObjects() {
  const selectedType = els.typeFilter.value;
  const objects = selectedType
    ? state.objects.filter((object) => object.type_name === selectedType)
    : state.objects;
  els.objectsList.replaceChildren();
  if (!objects.length) {
    els.objectsList.append(empty("No objects match this view."));
    return;
  }
  objects.forEach((object) => {
    const row = document.createElement("article");
    row.className = "object-row";
    row.classList.toggle("active", object.id === state.selectedObjectId);
    row.innerHTML = `<div class="object-title"></div><div class="object-meta"></div>`;
    row.querySelector(".object-title").textContent = titleFor(object);
    row.querySelector(".object-meta").textContent = object.type_name;
    row.addEventListener("click", () => selectObject(object.id));
    els.objectsList.append(row);
  });
}

function renderTimeline() {
  const temporal = state.objects.filter((object) => object.blob_ids.length);
  els.timelineList.replaceChildren();
  if (!temporal.length) {
    els.timelineList.append(empty("Objects with Blobs will appear here."));
    return;
  }
  temporal.forEach((object) => {
    const row = document.createElement("article");
    row.className = "timeline-row";
    row.textContent = `${titleFor(object)} · ${object.blob_ids.length} Blob${object.blob_ids.length === 1 ? "" : "s"}`;
    els.timelineList.append(row);
  });
}

function reviewItems() {
  return state.objects
    .filter((object) => object.type_name === "Page" && object.metadata?.review_status === "pending")
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function renderReview() {
  const items = reviewItems();
  els.reviewBadge.textContent = String(items.length);
  els.reviewQueue.replaceChildren();
  if (!items.length) {
    els.reviewQueue.append(empty("Nothing in review."));
    return;
  }
  items.forEach((object) => {
    const row = document.createElement("article");
    row.className = "review-item";
    row.classList.toggle("active", object.id === state.selectedObjectId);
    row.innerHTML = `
      <div class="review-title"></div>
      <div class="review-preview"></div>
    `;
    row.querySelector(".review-title").textContent = titleFor(object);
    row.querySelector(".review-preview").textContent = object.fields.content || "";
    row.addEventListener("click", () => selectObject(object.id));
    row.addEventListener("dblclick", () => openObjectInReviewEditor(object.id));
    els.reviewQueue.append(row);
  });
}

function renderTypeFilter() {
  const current = els.typeFilter.value;
  els.typeFilter.replaceChildren(new Option("All Types", ""));
  visibleTypes().forEach((type) => els.typeFilter.append(new Option(type.name, type.name)));
  els.typeFilter.value = current;
  const itemCurrent = els.typeListItemInput.value;
  els.typeListItemInput.replaceChildren(new Option("Object", "Object"));
  visibleTypes().forEach((type) => els.typeListItemInput.append(new Option(type.name, type.name)));
  els.typeListItemInput.value = itemCurrent || "Object";
  const fieldCurrent = els.typeFieldTypeInput.value;
  els.typeFieldTypeInput.replaceChildren(
    new Option("Text", "Text"),
    new Option("Number", "Number"),
    new Option("Boolean", "Boolean"),
    new Option("Date", "Date"),
    new Option("Image", "Image"),
    new Option("Video", "Video"),
    new Option("Blob", "Blob"),
    new Option("List", "List<T>")
  );
  visibleTypes()
    .filter((type) => type.name !== "Page" && !primitiveNames().has(type.name))
    .forEach((type) => els.typeFieldTypeInput.append(new Option(type.name, `Reference:${type.name}`)));
  els.typeFieldTypeInput.value = fieldCurrent || "Text";
}

function renderTypes() {
  els.typeList.replaceChildren();
  const primitive = primitiveNames();
  const types = visibleTypes().sort((a, b) => {
    const aPrimitive = primitive.has(a.name);
    const bPrimitive = primitive.has(b.name);
    if (aPrimitive !== bPrimitive) return aPrimitive ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!types.length) {
    els.typeList.append(empty("No Types yet."));
    return;
  }
  types.forEach((type) => {
    const row = document.createElement("article");
    row.className = "type-item";
    row.classList.toggle("active", type.name === state.selectedTypeName);
    row.innerHTML = `
      <div class="type-title"></div>
      <div class="object-meta"></div>
    `;
    row.querySelector(".type-title").textContent = type.name;
    row.querySelector(".object-meta").textContent = typeSummary(type);
    row.addEventListener("click", () => selectType(type.name));
    els.typeList.append(row);
  });
}

function typeSummary(type) {
  const metadata = type.metadata || {};
  if (metadata.kind === "list" || metadata.primitive === "List") return `${metadata.item_type || "Object"} List`;
  if (metadata.kind === "primitive") return `primitive · ${metadata.primitive || type.name}`;
  if (["Image", "Video", "Blob"].includes(metadata.kind)) return metadata.kind;
  const fieldCount = Array.isArray(type.fields) ? type.fields.length : 0;
  return `${metadata.kind || "group"} · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`;
}

function renderEditor() {
  if (state.activeView !== "review") {
    els.objectEditor.replaceChildren();
    els.editorTitle.textContent = "No object selected";
    return;
  }
  const object = state.objects.find((item) => item.id === state.selectedObjectId);
  els.objectEditor.replaceChildren();
  if (!object) {
    els.editorTitle.textContent = "No object selected";
    els.objectEditor.append(empty("Select an object to edit it with its Type fields."));
    return;
  }
  const activeTypeName = state.editorTypeName || object.type_name;
  const type = typeDef(activeTypeName);
  els.editorTitle.textContent = titleFor(object);
  if (!type) {
    els.objectEditor.append(empty(`Type ${activeTypeName} is not defined.`));
    return;
  }
  const typeField = document.createElement("div");
  typeField.className = "field";
  const typeLabel = document.createElement("label");
  typeLabel.htmlFor = "objectTypeSelect";
  typeLabel.textContent = "Type";
  const typeSelect = document.createElement("select");
  typeSelect.id = "objectTypeSelect";
  typeSelect.name = "type_name";
  visibleTypes().forEach((item) => typeSelect.append(new Option(item.name, item.name)));
  typeSelect.value = activeTypeName;
  typeSelect.addEventListener("change", () => {
    state.editorTypeName = typeSelect.value;
    renderEditor();
  });
  typeField.append(typeLabel, typeSelect);
  els.objectEditor.append(typeField);
  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.innerHTML = `<button class="primary" type="submit">Save</button><span class="status" role="status"></span>`;
  els.objectEditor.append(actions);
}

function valueForField(object, activeTypeName, field) {
  if (object.fields[field.name] !== undefined) return object.fields[field.name];
  if (object.type_name === "Page" && activeTypeName === "Goal") {
    if (field.name === "title") return object.fields.title || "";
    if (field.name === "description") return object.fields.content || "";
    if (field.name === "progress") return 0;
    if (field.name === "related_objects") return [];
  }
  return "";
}

function fieldsForTypeFromObject(object, typeName) {
  const type = typeDef(typeName);
  if (!type) return object.fields;
  const fields = {};
  type.fields.forEach((field) => {
    const value = valueForField(object, typeName, field);
    if (field.kind === "Number") {
      fields[field.name] = value === "" || value === null ? 0 : Number(value);
    } else if (field.kind === "Boolean") {
      fields[field.name] = Boolean(value);
    } else if (field.kind === "List<T>") {
      fields[field.name] = Array.isArray(value)
        ? value
        : String(value || "")
            .split("\n")
            .filter(Boolean);
    } else {
      fields[field.name] = value ?? "";
    }
  });
  return fields;
}

function renderField(field, value) {
  const wrap = document.createElement("div");
  wrap.className = field.kind === "Boolean" ? "field field-inline" : "field";
  const id = `field-${field.name}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = field.name;

  let input;
  if (field.kind === "Text" || field.kind === "List<T>" || field.kind === "Reference<Object>") {
    input = document.createElement("textarea");
    input.rows = field.kind === "Text" ? 4 : 2;
    input.value = Array.isArray(value) ? value.join("\n") : value || "";
  } else {
    input = document.createElement("input");
    input.type =
      field.kind === "Number"
        ? "number"
        : field.kind === "Date"
          ? "date"
          : field.kind === "Boolean"
            ? "checkbox"
            : "text";
    if (field.kind === "Boolean") {
      input.checked = Boolean(value);
    } else {
      input.value = value ?? "";
      if (field.kind === "Blob") input.placeholder = "Recurrence id";
      if (field.kind === "Image") input.placeholder = "Image URL or id";
      if (field.kind === "Video") input.placeholder = "Video URL or id";
    }
  }
  input.id = id;
  input.name = field.name;
  input.dataset.kind = field.kind;
  if (field.kind === "Boolean") {
    wrap.append(input, label);
  } else {
    wrap.append(label, input);
  }
  return wrap;
}

function readEditorFields() {
  const object = state.objects.find((item) => item.id === state.selectedObjectId);
  const type = typeDef(state.editorTypeName || object.type_name);
  const fields = {};
  type.fields.forEach((field) => {
    const input = els.objectEditor.elements[field.name];
    if (!input) return;
    if (field.kind === "Boolean") fields[field.name] = input.checked;
    else if (field.kind === "Number") fields[field.name] = input.value === "" ? null : Number(input.value);
    else if (field.kind === "List<T>") fields[field.name] = input.value.split("\n").filter(Boolean);
    else fields[field.name] = input.value;
  });
  return fields;
}

function renderAll() {
  renderTypeFilter();
  renderTypes();
  renderReview();
  renderGoals();
  renderObjects();
  renderTimeline();
  renderEditor();
  syncReviewEditTitle();
}

async function refresh() {
  const [types, objects] = await Promise.all([
    api.get("/lifeos/types"),
    api.get("/lifeos/objects"),
  ]);
  state.types = types;
  state.objects = objects;
  renderAll();
}

async function saveHomeDraft(options = {}) {
  const text = els.captureInput.value;
  if (!text.trim() || text === state.lastSavedHomeText || state.savingHomeDraft) return;
  state.savingHomeDraft = true;
  try {
    await api.send("/lifeos/capture", "POST", { text });
    state.lastSavedHomeText = text;
    els.captureInput.value = "";
    setStatus(els.captureStatus, "Sent to review.");
    await refresh();
  } catch (error) {
    if (!options.silent) setStatus(els.captureStatus, "Save failed.", true);
  } finally {
    state.savingHomeDraft = false;
  }
}

function saveHomeDraftOnExit() {
  const text = els.captureInput.value;
  if (!text.trim() || text === state.lastSavedHomeText) return;
  state.lastSavedHomeText = text;
  const body = JSON.stringify({ text });
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon("/lifeos/capture", blob);
    return;
  }
  fetch("/lifeos/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  });
}

function saveReviewEditOnExit() {
  const object = state.objects.find((item) => item.id === state.reviewEditingObjectId);
  const text = els.reviewFullEditor.value;
  if (!object || text === state.reviewEditLastSavedText) return;
  fetch(`/lifeos/objects/${object.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type_name: "Page",
      fields: {
        title: text.trim().split(/\n/)[0]?.slice(0, 120) || "Untitled",
        content: text,
      },
      metadata: object.metadata,
    }),
    keepalive: true,
  });
}

function enterReviewEditMode(object) {
  const shell = document.querySelector(".app-shell");
  state.reviewEditingObjectId = object.id;
  state.reviewEditLastSavedText = object.fields.content || "";
  els.reviewFullEditor.value = object.fields.content || "";
  shell?.setAttribute("data-review-mode", "edit");
  syncReviewEditTitle();
  requestAnimationFrame(() => els.reviewFullEditor.focus());
}

async function openObjectInReviewEditor(objectId) {
  const object = state.objects.find((item) => item.id === objectId);
  if (!object) return;
  state.activeView = "review";
  document.querySelector(".app-shell")?.setAttribute("data-active-view", "review");
  enterReviewEditMode(object);
}

function syncReviewEditTitle() {
  if (!state.reviewEditingObjectId) return;
  const object = state.objects.find((item) => item.id === state.reviewEditingObjectId);
  const title = object ? titleFor(object) : "Review";
  document.getElementById("reviewTitle").textContent = title;
}

async function saveReviewEdit() {
  const object = state.objects.find((item) => item.id === state.reviewEditingObjectId);
  const text = els.reviewFullEditor.value;
  if (!object || text === state.reviewEditLastSavedText) return;
  await api.send(`/lifeos/objects/${object.id}`, "PUT", {
    type_name: "Page",
    fields: {
      title: text.trim().split(/\n/)[0]?.slice(0, 120) || "Untitled",
      content: text,
    },
    metadata: object.metadata,
  });
  state.reviewEditLastSavedText = text;
  await refresh();
}

async function exitReviewEditMode(options = {}) {
  if (!state.reviewEditingObjectId) return;
  if (options.save !== false) {
    await saveReviewEdit();
  }
  state.reviewEditingObjectId = null;
  state.reviewEditLastSavedText = "";
  els.reviewFullEditor.value = "";
  document.querySelector(".app-shell")?.removeAttribute("data-review-mode");
  document.getElementById("reviewTitle").textContent = "Review";
  selectFirstReviewItem();
}

function selectFirstReviewItem() {
  const items = reviewItems();
  if (!items.length) {
    state.selectedObjectId = null;
    state.editorTypeName = null;
    renderEditor();
    return;
  }
  if (!items.some((item) => item.id === state.selectedObjectId)) {
    selectObject(items[0].id);
  }
}

function selectObject(id) {
  state.selectedObjectId = id;
  state.editorTypeName = null;
  renderAll();
}

async function createGoal() {
  const goal = await api.send("/lifeos/objects", "POST", {
    type_name: "Goal",
    fields: {
      title: "Untitled Goal",
      description: "",
      progress: 0,
      deadline: "",
      related_objects: [],
    },
  });
  await refresh();
  selectObject(goal.id);
  showView("goals");
}

async function createTypeFromForm(event) {
  event.preventDefault();
  setStatus(els.typeStatus, "");
  try {
    const name = els.typeNameInput.value.trim();
    const editingPrimitive = state.selectedTypeName && primitiveNames().has(state.selectedTypeName);
    const kind = editingPrimitive ? state.selectedTypeName : els.typeKindInput.value;
    const metadata = primitiveNames().has(kind)
      ? { kind: "primitive", primitive: kind }
      : { kind };
    if (kind === "list") {
      metadata.item_type = els.typeListItemInput.value || "Object";
    } else if (kind === "List") {
      metadata.item_type = els.typeListItemInput.value || "Object";
    }
    const fields =
      kind === "list" || kind === "List"
        ? [{ name: "items", kind: "List<T>", item_kind: metadata.item_type }]
        : [...state.typeDraftFields];
    if (state.selectedTypeName) {
      await api.send(`/lifeos/types/${encodeURIComponent(state.selectedTypeName)}`, "PUT", {
        metadata,
        fields,
      });
      setStatus(els.typeStatus, "Saved.");
    } else {
      await api.send("/lifeos/types", "POST", {
        name,
        metadata,
        fields,
      });
      setStatus(els.typeStatus, "Created.");
    }
    await refresh();
  } catch (error) {
    setStatus(els.typeStatus, error.message || "Could not create Type.", true);
  }
}

function selectType(typeName) {
  const type = typeDef(typeName);
  if (!type) return;
  const primitive = primitiveNames().has(type.name);
  state.selectedTypeName = type.name;
  els.typeNameInput.value = type.name;
  els.typeNameInput.disabled = true;
  els.typeKindInput.disabled = primitive;
  els.typeSubmitBtn.textContent = "Save Type";
  const metadata = type.metadata || {};
  const kind =
    metadata.kind === "primitive" && primitiveNames().has(metadata.primitive || type.name)
      ? metadata.primitive || type.name
      : metadata.kind || "group";
  els.typeKindInput.value = kind === "primitive" ? "group" : kind;
  if (!els.typeKindInput.value) els.typeKindInput.value = "group";
  if (metadata.item_type) els.typeListItemInput.value = metadata.item_type;
  state.typeDraftFields = [...(type.fields || [])];
  renderTypeDraftFields();
  applyTypeKindVisibility();
  renderTypes();
}

function resetTypeForm() {
  state.selectedTypeName = null;
  els.typeForm.reset();
  els.typeNameInput.disabled = false;
  els.typeKindInput.disabled = false;
  els.typeSubmitBtn.textContent = "Create Type";
  setStatus(els.typeStatus, "");
  applyTypeKindPreset();
  renderTypes();
}

function normalizeDraftField(name, typeValue) {
  const trimmedName = name.trim();
  if (!trimmedName) return null;
  if (typeValue.startsWith("Reference:")) {
    return {
      name: trimmedName,
      kind: "Reference<Object>",
      item_kind: typeValue.slice("Reference:".length),
    };
  }
  if (typeValue === "List<T>") {
    return { name: trimmedName, kind: "List<T>", item_kind: "Object" };
  }
  return { name: trimmedName, kind: typeValue };
}

function addTypeDraftField() {
  const field = normalizeDraftField(els.typeFieldNameInput.value, els.typeFieldTypeInput.value);
  if (!field) return;
  state.typeDraftFields.push(field);
  els.typeFieldNameInput.value = "";
  renderTypeDraftFields();
}

function renderTypeDraftFields() {
  els.typeFieldList.replaceChildren();
  state.typeDraftFields.forEach((field, index) => {
    const row = document.createElement("div");
    row.className = "type-field-row";
    const label = document.createElement("span");
    label.textContent = `${field.name} · ${displayFieldKind(field)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.typeDraftFields.splice(index, 1);
      renderTypeDraftFields();
    });
    row.append(label, remove);
    els.typeFieldList.append(row);
  });
}

function displayFieldKind(field) {
  if (field.kind === "Reference<Object>") return field.item_kind || "Object";
  if (field.kind === "List<T>") return `${field.item_kind || "Object"} List`;
  return field.kind;
}

function applyTypeKindPreset() {
  const kind = els.typeKindInput.value;
  applyTypeKindVisibility();
  if (kind === "list") {
    state.typeDraftFields = [];
  } else if (kind === "List") {
    state.typeDraftFields = [];
  } else if (kind === "Text") {
    state.typeDraftFields = [{ name: "value", kind: "Text" }];
  } else if (kind === "Number") {
    state.typeDraftFields = [{ name: "value", kind: "Number" }];
  } else if (kind === "Boolean") {
    state.typeDraftFields = [{ name: "value", kind: "Boolean" }];
  } else if (kind === "Date") {
    state.typeDraftFields = [{ name: "value", kind: "Date" }];
  } else if (kind === "Image") {
    state.typeDraftFields = [
      { name: "title", kind: "Text" },
      { name: "image", kind: "Image" },
    ];
  } else if (kind === "Video") {
    state.typeDraftFields = [
      { name: "title", kind: "Text" },
      { name: "video", kind: "Video" },
    ];
  } else if (kind === "Blob") {
    state.typeDraftFields = [
      { name: "title", kind: "Text" },
      { name: "recurrence", kind: "Blob" },
    ];
  } else {
    state.typeDraftFields = [{ name: "title", kind: "Text" }];
  }
  renderTypeDraftFields();
}

function applyTypeKindVisibility() {
  const listKind = els.typeKindInput.value === "list" || els.typeKindInput.value === "List";
  els.typeListItemField.hidden = !listKind;
  els.typeListItemField.style.display = listKind ? "grid" : "none";
}

function slashTarget() {
  if (state.activeView === "home") return els.captureInput;
  if (state.activeView === "review" && state.reviewEditingObjectId) return els.reviewFullEditor;
  return null;
}

function slashCommandForTarget(target) {
  if (!target) return null;
  const cursor = target.selectionStart;
  const before = target.value.slice(0, cursor);
  const lineStart = Math.max(before.lastIndexOf("\n") + 1, 0);
  const line = before.slice(lineStart);
  const match = line.match(/\/([A-Za-z0-9 _-]*)$/);
  if (!match) return null;
  return {
    target,
    query: match[1].trim(),
    start: lineStart + match.index,
    end: cursor,
  };
}

function commandTypes(query) {
  const normalized = query.toLowerCase();
  return state.types
    .filter((type) => type.name !== "Page" && type.name !== "Daily Log")
    .filter((type) => !normalized || type.name.toLowerCase().includes(normalized))
    .slice(0, 8);
}

function renderCommandPalette() {
  const command = slashCommandForTarget(slashTarget());
  if (!command) {
    els.commandPalette.hidden = true;
    return;
  }
  const types = commandTypes(command.query);
  els.commandPalette.replaceChildren();
  if (!types.length) {
    const emptyRow = document.createElement("div");
    emptyRow.className = "command-item active";
    emptyRow.innerHTML = `<div class="command-title">No matching Type</div><div class="command-meta">Create it in Type first</div>`;
    els.commandPalette.append(emptyRow);
    els.commandPalette.hidden = false;
    return;
  }
  types.forEach((type, index) => {
    const row = document.createElement("div");
    row.className = `command-item${index === 0 ? " active" : ""}`;
    row.innerHTML = `<div class="command-title"></div><div class="command-meta"></div>`;
    row.querySelector(".command-title").textContent = type.name;
    row.querySelector(".command-meta").textContent = typeSummary(type);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      runSlashCommand(type.name);
    });
    els.commandPalette.append(row);
  });
  els.commandPalette.hidden = false;
}

async function runSlashCommand(typeName = null) {
  const command = slashCommandForTarget(slashTarget());
  if (!command) return false;
  const selectedType =
    typeName ||
    commandTypes(command.query)[0]?.name ||
    state.types.find((type) => type.name.toLowerCase() === command.query.toLowerCase())?.name;
  if (!selectedType) return false;
  const target = command.target;
  target.value = `${target.value.slice(0, command.start)}${target.value.slice(command.end)}`;
  target.selectionStart = command.start;
  target.selectionEnd = command.start;
  els.commandPalette.hidden = true;
  const type = typeDef(selectedType);
  const object = await api.send("/lifeos/objects", "POST", {
    type_name: selectedType,
    fields: defaultFieldsForType(type),
    metadata: { created_from: "slash_command" },
  });
  await refresh();
  selectObject(object.id);
  await showView("objects");
  return true;
}

function defaultFieldsForType(type) {
  const fields = {};
  (type?.fields || []).forEach((field) => {
    if (field.kind === "Number") fields[field.name] = 0;
    else if (field.kind === "Boolean") fields[field.name] = false;
    else if (field.kind === "List<T>") fields[field.name] = [];
    else if (field.required && field.name === "title") fields[field.name] = `Untitled ${type.name}`;
    else if (field.required) fields[field.name] = "Untitled";
    else fields[field.name] = "";
  });
  return fields;
}

els.navItems.forEach((item) => {
  item.addEventListener("click", () => {
    showView(item.dataset.view);
  });
});

document.addEventListener("keydown", (event) => {
  const saveCombo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
  if (!saveCombo) return;
  event.preventDefault();
  if (state.activeView === "home") {
    saveHomeDraft();
  } else if (state.activeView === "review" && state.reviewEditingObjectId) {
    saveReviewEdit();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (slashCommandForTarget(slashTarget())) {
    event.preventDefault();
    runSlashCommand();
  }
});

["input", "keyup", "click"].forEach((eventName) => {
  els.captureInput.addEventListener(eventName, renderCommandPalette);
  els.reviewFullEditor.addEventListener(eventName, renderCommandPalette);
});

window.addEventListener("pagehide", () => {
  if (state.activeView === "home") {
    saveHomeDraftOnExit();
  } else if (state.activeView === "review" && state.reviewEditingObjectId) {
    saveReviewEditOnExit();
  }
});

els.reviewBackBtn.addEventListener("click", () => {
  exitReviewEditMode();
});

els.objectEditor.addEventListener("submit", async (event) => {
  event.preventDefault();
  const object = state.objects.find((item) => item.id === state.selectedObjectId);
  if (!object) return;
  const status = els.objectEditor.querySelector(".status");
  try {
    const savingFromReview = state.activeView === "review";
    const nextTypeName = state.editorTypeName || object.type_name;
    const updated = await api.send(`/lifeos/objects/${object.id}`, "PUT", {
      type_name: nextTypeName,
      fields: savingFromReview ? fieldsForTypeFromObject(object, nextTypeName) : readEditorFields(),
      metadata: {
        ...object.metadata,
        review_status:
          savingFromReview
            ? "reviewed"
            : (state.editorTypeName || object.type_name) === "Page"
              ? "pending"
              : "typed",
      },
    });
    state.editorTypeName = null;
    await refresh();
    if (savingFromReview) {
      selectFirstReviewItem();
    } else {
      selectObject(updated.id);
      setStatus(els.objectEditor.querySelector(".status"), "Saved.");
    }
  } catch (error) {
    setStatus(status, "Save failed.", true);
  }
});

els.typeFilter.addEventListener("change", renderObjects);
els.newGoalBtn.addEventListener("click", createGoal);
els.typeForm.addEventListener("submit", createTypeFromForm);
els.newTypeBtn.addEventListener("click", resetTypeForm);
els.addTypeFieldBtn.addEventListener("click", addTypeDraftField);
els.typeKindInput.addEventListener("change", applyTypeKindPreset);
els.typeFieldNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addTypeDraftField();
});

refresh().catch(() => {
  els.objectEditor.replaceChildren(empty("LifeOS API is unavailable."));
});

applyTypeKindPreset();
showView("home");
