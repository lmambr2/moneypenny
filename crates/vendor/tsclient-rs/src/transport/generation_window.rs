#[derive(Debug)]
pub struct GenerationWindow {
    mapped_base_offset: u32,
    generation: u32,
    r#mod: u32,
    receive_window: u32,
}

impl GenerationWindow {
    pub fn new(r#mod: u32, window_size: u32) -> Self {
        Self {
            mapped_base_offset: 0,
            generation: 0,
            r#mod,
            receive_window: window_size,
        }
    }

    #[allow(dead_code)]
    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn advance(&mut self, amount: u32) {
        if amount == 0 {
            return;
        }
        let new_base_offset = self.mapped_base_offset + amount;
        let gen_step = new_base_offset / self.r#mod;
        if gen_step > 0 {
            self.generation = self.generation.saturating_add(gen_step);
        }
        self.mapped_base_offset = new_base_offset % self.r#mod;
    }

    pub fn advance_to_excluded(&mut self, mapped_value: u32) {
        let move_dist = if mapped_value >= self.mapped_base_offset {
            mapped_value - self.mapped_base_offset
        } else {
            mapped_value + self.r#mod - self.mapped_base_offset
        };
        self.advance(move_dist + 1);
    }

    #[allow(dead_code)]
    pub fn sync_to(&mut self, mapped_value: u32) {
        let move_dist = if mapped_value >= self.mapped_base_offset {
            mapped_value - self.mapped_base_offset
        } else {
            mapped_value + self.r#mod - self.mapped_base_offset
        };
        self.advance(move_dist);
    }

    pub fn is_in_window(&self, mapped_value: u32) -> bool {
        let max_offset = self.mapped_base_offset + self.receive_window;
        if max_offset < self.r#mod {
            mapped_value >= self.mapped_base_offset && mapped_value < max_offset
        } else {
            mapped_value >= self.mapped_base_offset || mapped_value < max_offset - self.r#mod
        }
    }

    pub fn mapped_to_index(&self, mapped_value: u32) -> i64 {
        if self.is_next_gen(mapped_value) {
            mapped_value as i64 + self.r#mod as i64 - self.mapped_base_offset as i64
        } else {
            mapped_value as i64 - self.mapped_base_offset as i64
        }
    }

    pub fn is_old_packet(&self, mapped_value: u32) -> bool {
        self.mapped_to_index(mapped_value) < 0
    }

    #[allow(dead_code)]
    pub fn is_future_packet(&self, mapped_value: u32) -> bool {
        self.mapped_to_index(mapped_value) >= self.receive_window as i64
    }

    fn is_next_gen(&self, mapped_value: u32) -> bool {
        self.mapped_base_offset > self.r#mod - self.receive_window
            && mapped_value < self.mapped_base_offset + self.receive_window - self.r#mod
    }

    pub fn get_generation(&self, mapped_value: u32) -> u32 {
        if self.is_next_gen(mapped_value) {
            self.generation + 1
        } else {
            self.generation
        }
    }

    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.mapped_base_offset = 0;
        self.generation = 0;
    }
}
