/** Trust only the direct nginx peer in the fixed single-machine topology. */
export function trustSingleProxyHop(_address: string, hop: number): boolean {
  return hop === 0;
}
