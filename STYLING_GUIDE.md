# Form Styling Guide — TemplateBuilder v3.1 Applied Across Platform

## Overview
This guide documents how the TemplateBuilderV2.tsx styling system should be applied consistently across upload forms, document preview forms, and document detail forms.

## Color Palette (Finansys UniFi Design System)

### Primary Colors
| Color | Hex Code | Usage |
|-------|----------|-------|
| Primary Blue | #287EAD | Focus states, active buttons, headers, primary actions |
| Dark Blue | #1E6F99 | Borders, hover states for primary blue |
| Light Blue | #EEF6FB | Backgrounds for hover states, light accents |
| Very Light Blue | #D6EAF5 | Table row hover backgrounds |

### Neutral Colors
| Color | Hex Code | Usage |
|-------|----------|-------|
| Dark Gray | #1F2933 | Primary text, titles |
| Medium Gray | #5E6870 | Secondary text, labels, hints |
| Light Gray | #8C969E | Placeholder text, muted content |
| Border Gray | #AEB5BB | Input borders, dividers |
| Light Border | #C8CDD2 | Card borders, section separators |
| Lighter Border | #E5E8EB | Table row borders |
| Background Gray | #F0F2F4 | Table headers, card backgrounds |
| Sidebar Gray | #F6F7F8 | Sidebar backgrounds, light sections |
| Very Light | #F3F5F6 | Hover backgrounds for neutral buttons |

### Status Colors
| Color | Hex Code | Usage |
|-------|----------|-------|
| Destructive Red | #D32F2F | Errors, destructive actions (or use var(--destructive)) |

## Input Styling

### Standard Input Class
**CSS Location:** `frontend/src/index.css` (lines 184-193)

**Current CSS:**
```css
.input {
  @apply block w-full rounded-lg border px-3 py-2 text-sm shadow-sm
         focus:outline-none focus:ring-1;
  border-color: hsl(var(--input));
  background-color: hsl(var(--card));
  color: hsl(var(--foreground));
}
.input::placeholder {
  color: hsl(var(--muted-foreground));
}
.input:focus {
  border-color: hsl(var(--ring));
  --tw-ring-color: hsl(var(--ring));
}
```

**Preferred TemplateBuilder Styling (for consistency):**
```css
.input {
  @apply block w-full border px-3 py-2 text-sm focus:outline-none focus:ring-1;
  height: 36px;
  border-color: #AEB5BB;
  background-color: #ffffff;
  color: #1F2933;
  border-radius: 0; /* Match admin-shell for consistency */
}
.input::placeholder {
  color: #8C969E;
}
.input:focus {
  border-color: #287EAD;
  --tw-ring-color: #287EAD;
}
```

## Form Section Styling

### Modal/Card Container
**TemplateBuilderV2 Reference (line 513):**
```
border border-[#C8CDD2] bg-white shadow-2xl
```

### Modal Header
**TemplateBuilderV2 Reference (line 514):**
```
border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white
```

### Modal/Form Background
- Background: `#EDEDED` (for the outer container)
- Form body background: `#FFFFFF` (white)

### Sub-header / Instructions
**TemplateBuilderV2 Reference (line 196-199):**
```
border-b border-[#C8CDD2] bg-white px-6 py-2.5
```
- Text: `#5E6870` (medium gray)

### Field Preview in Tables
**TemplateBuilderV2 Reference (line 1124):**
```
h-8 border border-zinc-200 bg-white px-3 text-xs text-zinc-400 flex items-center
```

### Data Table Styling
**TemplateBuilderV2 References:**
- Header row: `bg-[#F0F2F4]`
- Column header: `text-[#1F2933]`
- Row border: `border-[#E5E8EB]`
- Row text: `text-[#8C969E]`
- Row hover: `hover:bg-[#EEF6FB]`
- Row hover text: `hover:text-[#287EAD]`

### Button Styling
**Primary Button:**
- Background: `#287EAD`
- Hover: `#1E6F99`
- Text: `#FFFFFF`

**Secondary Button:**
- Background: `#FFFFFF`
- Border: `#AEB5BB`
- Text: `#1F2933`
- Hover: `#F3F5F6`

## Implementation Areas

### 1. BuiltTemplateFormModal.tsx
**Status:** ✅ Already styled correctly
- Header uses `#287EAD` background
- Form area uses white background
- Instructions use `#5E6870` text
- Footer buttons already styled

**Ensure:**
- All form sections maintain white background
- Labels use `#5E6870` for secondary text
- Required field markers use red

### 2. TemplateForm.tsx
**Location:** `frontend/src/components/templates/TemplateForm.tsx`

**Updates Needed:**
- Update `.input` class in `index.css` to match UniFi colors
- Ensure all form elements use consistent spacing
- Table headers should use `#F0F2F4` background
- Table rows should use `#E5E8EB` borders

### 3. UploadPage.tsx
**Location:** `frontend/src/pages/UploadPage.tsx`

**Areas to Style:**
- Template preview form (line 843): Should wrap in a styled container matching BuiltTemplateFormModal
- Metadata fields: Ensure consistent styling with other forms
- OCR field display: Match the form styling

### 4. DocumentDetailPage.tsx
**Location:** `frontend/src/pages/DocumentDetailPage.tsx`

**Updates Needed:**
- Ensure TemplateForm rendering uses consistent styling
- Tab styling to match the form styling system
- Form section containers

### 5. DocumentViewer.tsx
**Location:** `frontend/src/components/documents/DocumentViewer.tsx`

**Updates Needed:**
- Form preview styling
- Edit controls
- Lock/Release buttons
- Preview styling consistency

## Spacing & Layout Standards

### Form Section Spacing
- Outer padding: `px-6 py-6`
- Section gap: `gap-4` between sections
- Field spacing: Grid system with 12 columns

### Modal/Container
- Outer container: 60px header + flexible content + 60px footer
- Body padding: `px-6 py-6`

### Label Spacing
- Label to input: `mb-1.5`
- Label font: `text-xs font-semibold`
- Help text: `text-xs` (muted)
- Required marker: Red, after label

## Typography Standards

### Headings
- Form title: `text-sm font-bold`
- Section title: `text-sm font-semibold`
- Labels: `text-xs font-semibold`

### Body Text
- Input text: `text-sm`
- Help text: `text-xs` (muted)
- Error messages: `text-xs text-red-500`

## Examples

### Input Field Structure
```tsx
<div>
  <label className="mb-1.5 block text-xs font-semibold text-[#1F2933]">
    Field Name
    {required && <span className="ml-1 text-red-500">*</span>}
  </label>
  <input className="input" placeholder="Enter value…" />
</div>
```

### Select Dropdown
```tsx
<select className="input">
  <option value="">Select…</option>
  {options.map(opt => <option value={opt}>{opt}</option>)}
</select>
```

### Table Preview
```tsx
<table className="w-full">
  <thead>
    <tr className="bg-[#F0F2F4]">
      <th className="px-3 py-2 text-left text-xs font-semibold text-[#1F2933]">Column</th>
    </tr>
  </thead>
  <tbody>
    <tr className="border-t border-[#E5E8EB] hover:bg-[#EEF6FB]">
      <td className="px-3 py-2 text-xs text-[#8C969E]">Cell</td>
    </tr>
  </tbody>
</table>
```

## Migration Checklist

- [ ] Update `.input` CSS class in `index.css`
- [ ] Verify BuiltTemplateFormModal styling
- [ ] Update TemplateForm table styling
- [ ] Style UploadPage form preview
- [ ] Update DocumentDetailPage form sections
- [ ] Test form styling in DocumentViewer
- [ ] Test responsive behavior on mobile
- [ ] Verify accessibility (color contrast ratios)
- [ ] Test with different field types (text, select, date, etc.)

## Resources

- **TemplateBuilderV2 Reference:** `/home/michael/Projects/IDM/frontend/src/pages/TemplateBuilderV2.tsx`
- **Current CSS:** `/home/michael/Projects/IDM/frontend/src/index.css` (lines 184-270)
- **Design System:** Finansys UniFi Color Palette
