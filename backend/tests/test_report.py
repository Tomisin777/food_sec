import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from report import build_monthly_report_csv, family_size_breakdown, reconstruct_pounds  # noqa: E402


class ReportTests(unittest.TestCase):
    def test_family_size_buckets(self):
        buckets = family_size_breakdown([1, 1, 4, 8, 12])
        self.assertEqual(buckets["1"], 2)
        self.assertEqual(buckets["4"], 1)
        self.assertEqual(buckets["8+"], 2)
        self.assertEqual(buckets["2"], 0)

    def test_reconstruct_pounds_prefers_logged_value(self):
        self.assertEqual(
            reconstruct_pounds(
                household_size=4,
                estimated_lbs=6.0,
                distribution_model="client_choice",
                default_pack_lbs=10,
            ),
            6.0,
        )
        self.assertEqual(
            reconstruct_pounds(
                household_size=4,
                estimated_lbs=None,
                distribution_model="pre_packed",
                default_pack_lbs=10,
            ),
            10,
        )
        self.assertEqual(
            reconstruct_pounds(
                household_size=4,
                estimated_lbs=None,
                distribution_model="client_choice",
                default_pack_lbs=10,
            ),
            40,
        )

    def test_csv_contains_required_tefap_fields(self):
        csv_body = build_monthly_report_csv(
            pantry_name="Northside Family Pantry",
            pantry_id="c1000000-0000-0000-0000-000000000001",
            year=2026,
            month=9,
            current_model="client_choice",
            checkins=[
                {"household_size": 4, "estimated_lbs": 12.0, "distribution_model": "client_choice"},
                {"household_size": 2, "estimated_lbs": 6.0, "distribution_model": "client_choice"},
                {"household_size": 8, "estimated_lbs": 10.0, "distribution_model": "pre_packed"},
            ],
            default_pack_lbs=10.3,
        )
        self.assertIn("Households served", csv_body)
        self.assertIn("3", csv_body)
        self.assertIn("Individuals served", csv_body)
        self.assertIn("14", csv_body)
        self.assertIn("Family size", csv_body)
        self.assertIn("Estimated / recorded pounds distributed", csv_body)
        self.assertIn("28.0", csv_body)
        self.assertIn("TEFAP", csv_body)
        self.assertIn("Northside Family Pantry", csv_body)
