import { type Delivery, type Order, type Piece } from "@/server/order/types.ts";

interface PieceTarget {
  order: Order;
  piece: Piece;
}

export function pieceTargets(d: Delivery): PieceTarget[] {
  return (d.orders ?? []).flatMap((order) =>
    (order.pieces ?? []).map((piece) => ({ order, piece })),
  );
}

export function resolveOwnedSource(
  d: Delivery,
  userId: number,
  sourcePieceId?: string | number,
): PieceTarget | undefined {
  const all = pieceTargets(d);
  if (sourcePieceId != null) {
    const matches = all.filter(({ piece }) => String(piece.id) === String(sourcePieceId));
    if (matches.length !== 1)
      throw new Error(`Piece ${sourcePieceId} was not found uniquely on delivery ${d.id}.`);
    const target = matches[0]!;
    if (target.piece.userId !== userId)
      throw new Error(`Piece ${sourcePieceId} is not verified as belonging to you.`);
    return target;
  }

  const owned = all.filter(({ piece }) => piece.userId === userId);
  if (owned.length > 1) {
    throw new Error(
      `You have ${owned.length} meals on delivery ${d.id}; pass sourcePieceId to choose which one to replace.`,
    );
  }
  return owned[0];
}
