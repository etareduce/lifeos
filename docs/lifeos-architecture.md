# LifeOS Architecture

LifeOS is text-first. The default user action is to open the app and start writing on a blank page. Structure is optional and can emerge later.

## Core Model

```text
Object
├── Type
├── Fields
├── Metadata
└── Blobs[]
```

Types define semantics and data structure. They do not define UI.

Objects store field values for a Type. Objects are long-lived pieces of information such as Pages, Goals, Projects, People, Books, and Notebooks.

Blobs carry temporal information. Objects are not inherently temporal; any Object with one or more Blobs appears on the Timeline.

## MVP Areas

- Home: blank-page capture into Page objects.
- Goals: first-class Goal objects with title, description, progress, optional deadline, and related objects.
- Daily Log: freeform daily writing with optional structured activities.
- Objects: browser and generic editor for typed objects.
- Timeline: objects with Blobs.

## Rendering

LifeOS owns rendering. Primitive field kinds map to generic editors:

- Text: multiline editor
- Number: numeric input
- Boolean: checkbox
- Date: date picker
- Reference<Object>: object selector
- List<T>: repeatable collection

Composite Types are rendered automatically from their fields. Custom Type-specific UI, layout builders, visual schema designers, and drag-and-drop editors are intentionally out of scope for the MVP.
