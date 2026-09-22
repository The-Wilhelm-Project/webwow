'use client';

/**
 * SliderInitializer - Client component that initializes Swiper on production pages.
 * Finds all [data-slider-id] elements, reads settings from data-slider-settings,
 * and mounts Swiper instances.
 */

import { useEffect, useRef } from 'react';
import Swiper from 'swiper';
import { ITEMS_INJECTED_EVENT } from '@/components/FilterableCollection';
import type { SliderSettings } from '@/types';
import {
  buildProductionSwiperOptions,
  applySwiperEasing,
  loadSwiperCss,
  configureBulletRenderer,
  syncSliderStateAttributes,
} from '@/lib/slider-utils';

/** Tag attached to sliders we've already mounted so re-scans skip them. */
const INITIALIZED_ATTR = 'data-slider-initialized';

/** A mounted slider plus what the cleanup needs to hand it back in its pre-init markup. */
interface MountedSlider {
  el: HTMLElement;
  swiper: Swiper;
  restoreMarkup: () => void;
}

/**
 * Snapshot the markup Swiper mutates so the slider can be mounted again after
 * `destroy(true, true)`: the inline styles of root, wrapper and slides (they
 * carry React-applied CSS vars such as `--bg-img`, which destroy() wipes) and
 * the pagination's template bullet (replaced by rendered bullets on init).
 * Needed because the effect cleanup runs while the DOM stays mounted, e.g.
 * when React re-runs effects in development.
 */
function snapshotSliderMarkup(el: HTMLElement): () => void {
  const styledNodes = [
    el,
    ...Array.from(
      el.querySelectorAll<HTMLElement>(':scope > .swiper-wrapper, :scope > .swiper-wrapper > .swiper-slide'),
    ),
  ];
  const styles = styledNodes.map((node) => [node, node.getAttribute('style')] as const);
  const paginationEl = el.querySelector<HTMLElement>('[data-slider-pagination]');
  const paginationHtml = paginationEl?.innerHTML;

  return () => {
    for (const [node, style] of styles) {
      if (style === null) node.removeAttribute('style');
      else node.setAttribute('style', style);
    }
    if (paginationEl && paginationHtml !== undefined) paginationEl.innerHTML = paginationHtml;
  };
}

export default function SliderInitializer() {
  const swiperInstancesRef = useRef<MountedSlider[]>([]);

  useEffect(() => {
    loadSwiperCss(document);

    // Sliders initialized while hidden (e.g. `hidden max-lg:flex`) measure their
    // slides as zero-width; a media-query `display` change doesn't fire a window
    // resize, so Swiper never recalculates. Watch each slider's size and call
    // `update()` once it becomes visible so slides pick up their real widths.
    const swiperByElement = new WeakMap<Element, Swiper>();
    const resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.contentRect.width <= 0) return;
        swiperByElement.get(entry.target)?.update();
      });
    });

    const initSliders = () => {
      const sliderElements = document.querySelectorAll<HTMLElement>(
        `[data-slider-id]:not([${INITIALIZED_ATTR}])`,
      );

      sliderElements.forEach((el) => {
        const settingsJson = el.getAttribute('data-slider-settings');
        if (!settingsJson) return;

        try {
          const settings: SliderSettings = JSON.parse(settingsJson);
          const config = buildProductionSwiperOptions(settings);

          if (config.navigation && typeof config.navigation === 'object') {
            config.navigation.nextEl = el.querySelector('[data-slider-next]') as HTMLElement;
            config.navigation.prevEl = el.querySelector('[data-slider-prev]') as HTMLElement;
          }
          if (config.pagination && typeof config.pagination === 'object') {
            const isFraction = settings.paginationType === 'fraction';
            const selector = isFraction ? '[data-slider-fraction]' : '[data-slider-pagination]';
            config.pagination.el = el.querySelector(selector) as HTMLElement;
          }

          configureBulletRenderer(el, config);

          const restoreMarkup = snapshotSliderMarkup(el);
          const swiper = new Swiper(el, config);
          applySwiperEasing(el, settings.easing);
          syncSliderStateAttributes(swiper);

          const paginationEl = el.querySelector('[data-slider-pagination]') as HTMLElement | null;
          if (paginationEl) paginationEl.style.visibility = '';

          el.setAttribute(INITIALIZED_ATTR, '');
          swiperInstancesRef.current.push({ el, swiper, restoreMarkup });
          swiperByElement.set(el, swiper);
          resizeObserver.observe(el);
        } catch {
          console.error('Failed to initialize slider:', el.getAttribute('data-slider-id'));
        }
      });
    };

    initSliders();

    // Re-scan after filter/load-more injects new collection items so sliders
    // inside those items get mounted. Defer to the next frame so the DOM has
    // settled after injection.
    let pendingScan = 0;
    const handleItemsInjected = () => {
      cancelAnimationFrame(pendingScan);
      pendingScan = requestAnimationFrame(() => {
        pendingScan = 0;
        initSliders();
      });
    };
    window.addEventListener(ITEMS_INJECTED_EVENT, handleItemsInjected);

    return () => {
      window.removeEventListener(ITEMS_INJECTED_EVENT, handleItemsInjected);
      // A scan queued by an injection right before the cleanup must not run
      // against the disconnected observer and the emptied instance list.
      cancelAnimationFrame(pendingScan);
      resizeObserver.disconnect();
      swiperInstancesRef.current.forEach(({ el, swiper, restoreMarkup }) => {
        swiper.destroy(true, true);
        restoreMarkup();
        // Let a later effect run mount this slider again. Without this, React's
        // development re-run of effects (Strict Mode) destroyed every slider
        // and then skipped it as already initialized, so no slider ever moved.
        el.removeAttribute(INITIALIZED_ATTR);
      });
      swiperInstancesRef.current = [];
    };
  }, []);

  return null;
}
