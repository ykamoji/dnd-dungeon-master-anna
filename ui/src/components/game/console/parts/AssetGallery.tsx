"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type { Assets } from "@/lib/types";
import { resolveAssetUrl } from "@/lib/assetUrl";

interface AssetGalleryProps {
  assets?: Assets[] | null;
  alt?: string;
  className?: string;
}

/**
 * Live scene art for the current turn. Displays a horizontal stack of thumbnails
 * which can be clicked to enlarge in a full-screen modal overlay.
 */
export function AssetGallery({ assets, alt = "Scene art", className = "" }: AssetGalleryProps) {
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const images = (assets ?? [])
    .map((asset) => ({ asset, url: resolveAssetUrl(asset?.URL) }))
    .filter((item): item is { asset: Assets; url: string } => Boolean(item.url));
  if (images.length === 0) return null;

  return (
    <>
      <div className={`flex flex-row flex-wrap gap-4 ${className}`}>
        {images.map(({ asset, url }, i) => (
          <div key={url}>
            <img
              src={url}
              alt={`${alt} ${i + 1}`}
              className="h-48 w-64 cursor-pointer rounded-card border border-gold/30 object-cover shadow-sm transition-transform hover:scale-105"
              onClick={() => setZoomedUrl(url)}
            />
            <span>{asset.description}</span>
          </div>
        ))}
      </div>

      {mounted && createPortal(
        <AnimatePresence>
          {zoomedUrl && (
            <motion.div
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-8 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setZoomedUrl(null)}
            >
              <motion.img
                src={zoomedUrl}
                alt={alt}
                className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
                initial={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.95 }}
                onClick={(e) => e.stopPropagation()}
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
