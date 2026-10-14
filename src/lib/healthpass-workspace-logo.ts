import { useQuery } from "@tanstack/react-query";
import { careApi } from "./healthpass-client";
import type { Me } from "./healthpass-types";
export const workspaceLogoKey = (me: Me) => ["workspace-logo", me.user.id, me.organization?.id];
export function useWorkspaceLogo(me: Me) {
  return useQuery<{ logo: string | null }>({
    queryKey: workspaceLogoKey(me),
    queryFn: () => careApi("/workspace/logo"),
    enabled: !!me.organization && !me.pendingMembership && !me.accessExpired,
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
export function workspaceInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => Array.from(word)[0])
          .join("")
      : Array.from(words[0] || "WS")
          .slice(0, 2)
          .join("")
  ).toUpperCase();
}
/** Resize locally so the uploaded original (up to 5 MB) never slows every sidebar render. */
export async function prepareWorkspaceLogo(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG or WebP image.");
  }
  if (!file.size || file.size > 5 * 1024 * 1024) {
    throw new Error("Choose an image up to 5 MB.");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("Invalid image");
    }
    const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image processing unavailable");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    throw new Error("This image could not be read. Choose another PNG, JPEG or WebP image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
