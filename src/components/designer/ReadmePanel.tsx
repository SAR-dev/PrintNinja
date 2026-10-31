import { ReadmeEditor } from "@/components/ReadmeEditor";

interface Props {
  readme: string;
  onChange: (value: string) => void;
  templateName: string;
  /** A saved copy: viewable, but not editable. */
  readOnly?: boolean;
}

/**
 * The template's README: the Markdown editor, filling its parent edge to
 * edge. It has no Save of its own; the Designer's Save sends it with the
 * rest of the template.
 */
export function ReadmePanel({
  readme,
  onChange,
  templateName,
  readOnly = false,
}: Props) {
  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <ReadmeEditor
        value={readme}
        onChange={onChange}
        templateName={templateName}
        readOnly={readOnly}
      />
    </div>
  );
}
