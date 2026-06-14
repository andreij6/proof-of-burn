//! course_nft — ICRC-7 NFT ledger for minted mini-golf courses (PB-301).
//!
//! SCAFFOLD STUB. The full core-ICRC-7 implementation per
//! `ideas/course-nft/tasks/01-coursenft-canister-icrc7.md` is filled in by the
//! PB-301 implementation pass. This stub exists only so the workspace compiles
//! and `cargo test -p course_nft` runs while other layers are built in parallel.

#[ic_cdk::query]
fn icrc7_name() -> String {
    "Caldera Courses".to_string()
}

ic_cdk::export_candid!();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_set() {
        assert_eq!(icrc7_name(), "Caldera Courses");
    }
}
