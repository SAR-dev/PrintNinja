import { ReadmeEditor } from "@/components/ReadmeEditor";

interface Props {
  readme: string;
  onChange: (value: string) => void;
  templateName: string;
  saving: boolean;
  onSave: () => void;
  /** A saved copy: viewable, but not editable or saveable. */
  readOnly?: boolean;
}

/** The template's README: the Markdown editor, with Save at the end of its tool row. */
export function ReadmePanel({
  readme,
  onChange,
  templateName,
  saving,
  onSave,
  readOnly = false,
}: Props) {
  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <ReadmeEditor
        value={readme}
        onChange={onChange}
        templateName={templateName}
        readOnly={readOnly}
        onSave={onSave}
        saving={saving}
      />
    </div>
  );
}
