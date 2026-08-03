import type { Product } from "../types";

/** Deterministic seed catalog. Prices are fixed cents; stock is fixed. */
export const PRODUCTS: Product[] = [
    {
        id: "p-nova-hp",
        slug: "nova-headphones",
        name: "Nova Wireless Headphones",
        category: "audio",
        priceCents: 12900,
        stock: 8,
        description: "Over-ear wireless headphones with 40h battery and ANC.",
    },
    {
        id: "p-echo-buds",
        slug: "echo-buds",
        name: "Echo Buds Pro",
        category: "audio",
        priceCents: 7999,
        stock: 15,
        description: "True-wireless earbuds with adaptive noise cancelling.",
    },
    {
        id: "p-boom-spk",
        slug: "boom-speaker",
        name: "Boom Portable Speaker",
        category: "audio",
        priceCents: 4999,
        stock: 0,
        description: "IP67 waterproof speaker. This unit is out of stock.",
    },
    {
        id: "p-clack-kb",
        slug: "clack-keyboard",
        name: "Clack Mechanical Keyboard",
        category: "input",
        priceCents: 14900,
        stock: 6,
        description: "Hot-swappable 75% keyboard with gasket mount.",
    },
    {
        id: "p-pulse-mouse",
        slug: "pulse-mouse",
        name: "Pulse Ergonomic Mouse",
        category: "input",
        priceCents: 5900,
        stock: 12,
        description: "Wireless ergonomic mouse with silent switches.",
    },
    {
        id: "p-lumen-pad",
        slug: "lumen-webcam",
        name: "Lumen 4K Webcam",
        category: "input",
        priceCents: 11900,
        stock: 4,
        description: "4K webcam with a privacy shutter.",
    },
    {
        id: "p-halo-mon",
        slug: "halo-monitor",
        name: "Halo 27\" 4K Monitor",
        category: "display",
        priceCents: 34900,
        stock: 5,
        description: "27-inch 4K IPS monitor with USB-C power delivery.",
    },
    {
        id: "p-arc-display",
        slug: "arc-display",
        name: "Arc 24\" FHD Monitor",
        category: "display",
        priceCents: 13900,
        stock: 9,
        description: "Budget 24-inch Full-HD monitor for desk setups.",
    },
    {
        id: "p-lift-desk",
        slug: "lift-desk",
        name: "Lift Standing Desk",
        category: "furniture",
        priceCents: 39900,
        stock: 3,
        description: "Electric sit-stand desk with 120cm top.",
    },
    {
        id: "p-cush-chair",
        slug: "cush-chair",
        name: "Cush Ergonomic Chair",
        category: "furniture",
        priceCents: 24900,
        stock: 7,
        description: "Breathable mesh chair with lumbar support.",
    },
];

/** The one deterministic coupon: 10% off the whole order. */
export const COUPONS: Record<string, { label: string; percentOff: number }> = {
    WELCOME10: { label: "Welcome discount", percentOff: 10 },
};

export const FIXTURE_ANCHOR = Date.parse("2026-04-01T00:00:00.000Z");
