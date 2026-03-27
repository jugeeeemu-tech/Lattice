use crate::graph::{synthesize_proxmox_uplinks, Topology};

pub fn attach_proxmox_uplinks(topology: &mut Topology) {
    let links = synthesize_proxmox_uplinks(topology);
    let existing_ids = topology
        .links
        .iter()
        .map(|link| link.id.clone())
        .collect::<std::collections::HashSet<_>>();

    for link in links {
        if !existing_ids.contains(&link.id) {
            topology.links.push(link);
        }
    }

    topology.links.sort_by(|left, right| left.id.cmp(&right.id));
}
