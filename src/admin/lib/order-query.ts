import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, keys } from "./api"

// Both order widgets read the same query, so the page makes one request.
export const useOrderView = (orderId: string) =>
  useQuery({ queryKey: keys.order(orderId), queryFn: () => api.order(orderId) })

// After an order mutation: this view, the dashboard's order queries and the
// attention count.
export const useInvalidateOrder = (orderId: string) => {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: keys.order(orderId) })
    queryClient.invalidateQueries({ queryKey: ["orders"] })
    queryClient.invalidateQueries({ queryKey: keys.attentionAll })
  }
}
