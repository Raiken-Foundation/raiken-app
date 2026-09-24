/** Domain types for the Bazaar storefront fixture — deterministic like Orbit. */

export type ProductCategory = "audio" | "input" | "display" | "furniture";

export interface Product {
    id: string;
    slug: string;
    name: string;
    category: ProductCategory;
    priceCents: number;
    /** Fixed stock; "add to cart" decrements it, at 0 the product is sold out. */
    stock: number;
    description: string;
}

export interface CartLine {
    productId: string;
    quantity: number;
}

export interface Cart {
    lines: CartLine[];
    /** Applied coupon code, when one is active. */
    coupon: string | null;
}

export interface Order {
    id: string;
    placedAt: string;
    lines: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    shipping: { name: string; address: string; zip: string };
}
