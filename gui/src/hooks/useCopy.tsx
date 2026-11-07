import { useCallback, useState } from "react";

export default function useCopy(text: string | (() => string)) {
  const [copied, setCopied] = useState<boolean>(false);

  const copyText = useCallback(() => {
    const textVal = typeof text === "string" ? text : text();
    void navigator.clipboard.writeText(textVal);

    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return { copied, copyText };
}
