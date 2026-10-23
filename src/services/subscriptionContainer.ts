import {
  InMemorySubscriptionProductRepository,
  type SubscriptionProductRepository,
} from "../modules/subscriptions/subscription-product-repository.js";
import {
  InMemorySubscriptionRepository,
  type SubscriptionRepository,
} from "../modules/subscriptions/subscription-repository.js";
import { InMemorySlotRepository, type SlotRepository } from "../modules/slots/slot-repository.js";
import { SubscriptionService } from "./subscriptionService.js";

export interface SubscriptionRepositories {
  products: SubscriptionProductRepository;
  subscriptions: SubscriptionRepository;
  slots: SlotRepository;
}

/** A fresh composition for tests; one default composition per application process. */
export function createSubscriptionContainer(repositories: Partial<SubscriptionRepositories> = {}) {
  const products = repositories.products ?? new InMemorySubscriptionProductRepository();
  const subscriptions = repositories.subscriptions ?? new InMemorySubscriptionRepository();
  const slots = repositories.slots ?? new InMemorySlotRepository();
  return {
    products,
    subscriptions,
    slots,
    service: new SubscriptionService(products, subscriptions, slots),
  };
}

export const subscriptionContainer = createSubscriptionContainer();
export const subscriptionService = subscriptionContainer.service;
